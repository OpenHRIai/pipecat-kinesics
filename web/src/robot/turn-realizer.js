// The turn cue realizer: turns the bot's announced turn (src/turn-cues.js) into G1 joint targets.
//
// Two movements, each a number from 0 to 1
// that blends between key poses (turn-poses.json):
//
//   arms   0 = at rest by the sides (listening), 1 = raised in front of the body (bid, speaking, hold)
//   torso  0 = facing the person, 1 = turned a little away (while speaking)
//
// Every movement is a smooth curve (minimum jerk: no sudden start or stop) from wherever the body is
// to where it should be, timed against the sound as it will be heard on this page:
//
//   bid        arms up, in place at the first sound.  Starts at the first message with text_started,
//              or 0.7 s before the first sound, whichever is later.  A bid that starts on an estimate
//              of the first sound is re-timed when the exact time arrives (bid-retime, below)
//   turn away  torso away, starting at the first sound, for replies longer than 1.6 s
//   turn back  torso back to the person, starting 0.5 s before the last sound
//   lower      arms down, starting at the last sound, at rest 0.5 s later
//   cancelled  arms down and torso back at once
//   interrupted  the same, a little faster
//
// When a cue arrives too late for a movement's normal duration, the movement is made faster, down
// to 2/3 of it; later still, it starts at once and finishes after the moment it aimed at.
//
// Re-timing a bid.  Before any audio exists, the first sound is only an estimate (a fixed 510 ms after
// the first text), and the bid usually starts on it.  The exact time arrives about 0.3 s before the
// sound is heard in Chrome.  If the arms are still rising then, the rest of their curve is stretched or
// compressed to finish at the first sound: the same curve, from where the arms are, at between 2/3 and
// 3/2 of the speed it had.  Arms already in place stay there.  Only once the clock is trusted (the
// tracker's clockReady): before the sound lag is measured, the exact time can be 0.1 s off, and
// re-timing would hand that error to the bid.
//
// Without cue messages (?cues=audio in the page address, or no message for 3 s), the realizer falls
// back on the audio the page hears: arms up when sound starts, down after 0.8 s of quiet.  That is all
// a client can do without the protocol, so it is the baseline the protocol is judged against.
//
// The realizer only says where the joints should be; the robot loop passes that through the same
// limiter and simulated controller as the pose stream.

import POSES from './turn-poses.json' with { type: 'json' };

export const MOVE_MS = { bid: 700, away: 600, back: 500, lower: 500, cancel: 500, interrupt: 400, audioUp: 467, audioDown: 500 };
export const MIN_FACTOR = 2 / 3;          // the fastest a movement is made, as a share of its normal duration
export const BID_LEAD_MS = MOVE_MS.bid;   // the bid aims to be in place at the first sound
export const BACK_LEAD_MS = MOVE_MS.back; // the torso is back with the person at the last sound
export const AWAY_MIN_REPLY_MS = 1600;    // shorter replies keep the torso facing the person
export const AUDIO_QUIET_MS = 800;        // fallback: quiet this long ends the bot's turn
export const RETIME_MIN_MS = 15;          // a rising bid is re-timed only if it would miss the first sound by more
const IN_PLACE = 0.1;                     // a movement is in place within 10% of its span of the target

// Minimum-jerk curve from 0 to 1.
const smooth = (s) => (s <= 0 ? 0 : s >= 1 ? 1 : s * s * s * (10 - 15 * s + 6 * s * s));
// The share of a movement's duration after which its command is within IN_PLACE of the target.
const S_IN_PLACE = (() => { let lo = 0, hi = 1; for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (smooth(m) < 1 - IN_PLACE) lo = m; else hi = m; } return hi; })();

class Channel {
  constructor() { this.from = 0; this.to = 0; this.start = -Infinity; this.dur = 1; this.move = null; }
  value(t) { return t <= this.start ? this.from : this.from + (this.to - this.from) * smooth((t - this.start) / this.dur); }
  go(to, t, dur, move) { this.from = this.value(t); this.to = to; this.start = t; this.dur = Math.max(dur, 1); this.move = move; }
  /** End time of the current movement. */
  get end() { return this.start + this.dur; }
  /**
   * Make the movement under way finish at `end` instead, keeping its curve and where it is now: the
   * part of the curve still to run is played faster or slower, by at most `maxFactor` either way.
   * @returns the end it will now finish at, or null if it is not under way
   */
  retime(t, end, maxFactor) {
    if (t <= this.start || t >= this.end) return null;
    const s0 = (t - this.start) / this.dur;
    const left = (1 - s0) * this.dur;                  // time still to run at the present speed
    const want = Math.min(left * maxFactor, Math.max(left / maxFactor, end - t));
    const dur = want / (1 - s0);
    this.start = t - s0 * dur; this.dur = dur;
    return this.end;
  }
}

/** Joint vectors for the key poses, in MuJoCo hinge order (the robot loop's `wanted`). */
export function keyPoses(mujoco, model, ix, standJoints) {
  const index = (name) => {
    const j = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT.value, name);
    const h = ix.hinges.indexOf(j);
    if (h < 0) throw new Error(`turn-poses.json: the G1 model has no joint ${name}`);
    return h;
  };
  const pose = (spec, base) => { const q = Float64Array.from(base); for (const [n, v] of Object.entries(spec)) q[index(n)] = v; return q; };
  const rest = pose(POSES.rest, standJoints);
  const ready = pose(POSES.ready, rest);
  const turn = new Float64Array(rest.length);
  for (const [n, v] of Object.entries(POSES.turn)) turn[index(n)] = v;
  return { rest, ready, turn };
}

export class TurnRealizer {
  /** poses: { rest, ready, turn } from keyPoses(). */
  constructor(poses) {
    this.poses = poses;
    const { rest, ready, turn } = poses;
    this.armDelta = Float64Array.from(rest, (r, i) => ready[i] - r);
    this.armNorm = this.armDelta.reduce((s, d) => s + d * d, 0);
    this.turnIdx = turn.findIndex((x) => x !== 0);
    this.turnSpan = turn[this.turnIdx];
    this.q = new Float64Array(rest.length);
    this.reset();
  }

  reset() {
    this.arms = new Channel(); this.torso = new Channel();
    this.planned = new Map();     // name -> { channel, to, at, dur, kind, aim }: movements not started yet
    this.turn = 0; this.done = new Set(); // the current turn, and the movements already started in it
    this.moves = [];              // movements started, for the report; drained by take()
    this.open = [];               // started movements still waiting to be in place
    this.source = 'cues';         // or 'audio', the fallback
    this.heard = false; this.lastLoud = -Infinity;
  }

  /**
   * Plan the movements for the newest state of the bot's turn.  Call on every new state.
   * @param tracker  a CueTracker
   * @param now      local time (performance.now())
   * @param extraMs  what this client adds after the point where it hears the sound: on the page, the
   *                 loudspeaker's playout delay plus the manual adjustment (src/turn-cues.js)
   */
  plan(tracker, now, extraMs) {
    const m = tracker.state;
    if (!m || m.turn === 0) return;
    this.source = 'cues';
    if (m.turn !== this.turn) { this.turn = m.turn; this.done.clear(); this.planned.clear(); }
    const heard = (ms) => tracker.heardAt(ms, extraMs);
    const onset = heard(m.onset_ms), end = heard(m.end_ms);
    const ctx = { turn: m.turn, rev: m.rev, offsetMs: tracker.offsetMs, lagMs: tracker.lagMs, extraMs, onsetExact: !!m.onset_exact };

    if (m.status === 'cancelled' || m.status === 'interrupted') {
      this.planned.clear();
      const kind = m.status === 'cancelled' ? 'cancel' : 'interrupt';
      if (!this.done.has(kind)) {
        this.done.add(kind);
        this._start(this.arms, 0, now, MOVE_MS[kind], { ...ctx, kind, aim: 'now', plannedMs: now });
        this._start(this.torso, 0, now, MOVE_MS[kind], { ...ctx, kind: kind + '-torso', aim: 'now', plannedMs: now });
      }
      return;
    }
    // Bid: in place at the first sound; not before the first text, when that is known.
    if (Number.isFinite(onset) && (m.text_started || m.onset_exact)) {
      const textAt = tracker.textAt.get(m.turn) ?? now;
      this._plan('bid', this.arms, 1, Math.max(textAt, onset - BID_LEAD_MS), onset, MOVE_MS.bid, now, { ...ctx, aim: 'onset', key: 'end', soundMs: onset });
    }
    // A bid under way, started on an estimate of the first sound: finish it at the exact time.
    if (Number.isFinite(onset) && m.onset_exact && tracker.clockReady && this.arms.move === 'bid'
        && Math.abs(this.arms.end - onset) > RETIME_MIN_MS) {
      const was = this.arms.end, from = this.arms.value(now);
      const end = this.arms.retime(now, onset, 1 / MIN_FACTOR);
      if (end !== null) {
        this._record(this.arms, from, 1, now, end - now, { ...ctx, kind: 'bid-retime', aim: 'onset', key: 'end', soundMs: onset,
          wantedMs: now, plannedMs: now, shiftMs: end - was,
          // The whole curve, for body lag: its span, and when its command is in place.
          span: Math.abs(this.arms.to - this.arms.from), commandInPlaceMs: this.arms.start + S_IN_PLACE * this.arms.dur });
      }
    }
    // Turn away while speaking, if the reply is long enough to turn back again.
    if (Number.isFinite(onset) && (!Number.isFinite(end) || end - onset >= AWAY_MIN_REPLY_MS)) {
      this._plan('away', this.torso, 1, onset, onset + MOVE_MS.away, MOVE_MS.away, now, { ...ctx, aim: 'onset', key: 'start', soundMs: onset });
    } else this.planned.delete('away');
    // Yield: the torso back by the last sound, then the arms down from it.
    if (Number.isFinite(end)) {
      this._plan('back', this.torso, 0, end - BACK_LEAD_MS, end, MOVE_MS.back, now, { ...ctx, aim: 'end', key: 'end', soundMs: end });
      this._plan('lower', this.arms, 0, end, end + MOVE_MS.lower, MOVE_MS.lower, now, { ...ctx, aim: 'end', key: 'start', soundMs: end });
    }
  }

  /**
   * The audio fallback, called once per drawn frame with the level of the bot's audio as decoded.
   * Only acts while `active` (no cue messages coming).
   */
  audio(now, loud, active) {
    if (loud) this.lastLoud = now;
    if (!active) { this.heard = loud || (this.heard && now - this.lastLoud < AUDIO_QUIET_MS); return; }
    if (this.source !== 'audio') { this.source = 'audio'; this.planned.clear(); }
    const ctx = { turn: null, kind: '', aim: 'now', plannedMs: now, source: 'audio' };
    if (loud && !this.heard) {
      this.heard = true;
      this._start(this.arms, 1, now, MOVE_MS.audioUp, { ...ctx, kind: 'audio-up' });
    } else if (this.heard && !loud && now - this.lastLoud >= AUDIO_QUIET_MS) {
      this.heard = false;
      this._start(this.arms, 0, now, MOVE_MS.audioDown, { ...ctx, kind: 'audio-down' });
    }
  }

  /** Joint targets for local time t, MuJoCo hinge order.  Starts any planned movement now due. */
  target(t) {
    if (this.planned.size) {
      for (const [name, p] of [...this.planned].sort((a, b) => a[1].at - b[1].at)) {
        if (p.at > t) break;
        this.planned.delete(name);
        // Start from where the body is, at the speed that still lands on time, but no faster than 2/3 of normal.
        const dur = Math.max(p.normal * MIN_FACTOR, Math.min(p.normal, p.doneBy - t));
        this._start(p.channel, p.to, t, dur, { ...p.info, plannedMs: p.at });
      }
    }
    const a = this.arms.value(t), w = this.torso.value(t), { rest } = this.poses;
    for (let i = 0; i < rest.length; i++) this.q[i] = rest[i] + a * this.armDelta[i];
    this.q[this.turnIdx] += w * this.turnSpan;
    return this.q;
  }

  /**
   * After each control tick: where the body actually is (joint angles, MuJoCo hinge order, as read
   * from the simulation), so that each movement's report says when the limb was in place.
   */
  observe(actual, t) {
    if (!this.open.length) return;
    let a = 0;
    for (let i = 0; i < actual.length; i++) a += (actual[i] - this.poses.rest[i]) * this.armDelta[i];
    a /= this.armNorm;
    const w = (actual[this.turnIdx] - this.poses.rest[this.turnIdx]) / this.turnSpan;
    this.open = this.open.filter((r) => {
      const v = r.channel === 'arms' ? a : w;
      if (Math.abs(v - r.to) > IN_PLACE * Math.max(r.span ?? Math.abs(r.to - r.from), 0.1)) return true;
      r.inPlaceMs = Math.round(t * 10) / 10;
      // Body lag: how much later the limb was in place than its command was.
      r.bodyLagMs = Math.round((t - (r.commandInPlaceMs ?? r.startMs + S_IN_PLACE * r.durMs)) * 10) / 10;
      return false;
    });
  }

  /** Started movements since the last call, for the report to the recorder. */
  take() { return this.moves.splice(0); }

  /** A movement wanted to start at `at` and to be finished by `doneBy` (local times), normally lasting `normal` ms. */
  _plan(name, channel, to, at, doneBy, normal, now, info) {
    if (this.done.has(name)) return;
    if (!Number.isFinite(at)) return;
    this.planned.set(name, { channel, to, at: Math.max(at, now), doneBy, normal, info: { ...info, kind: name, wantedMs: at } });
  }

  _start(channel, to, t, dur, info) {
    if (info.kind && info.turn !== null) this.done.add(info.kind);
    const from = channel.value(t);
    channel.go(to, t, dur, info.kind);
    this._record(channel, from, to, t, dur, info);
  }

  /** A movement started or re-timed at t, lasting dur from then: one record for the report. */
  _record(channel, from, to, t, dur, info) {
    const r = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
    const rec = {
      kind: info.kind, turn: info.turn ?? null, rev: info.rev ?? null, source: info.source ?? 'cues',
      channel: channel === this.arms ? 'arms' : 'torso', from: Math.round(from * 1000) / 1000, to,
      // On this page's clock: when the movement should have started, when it was planned to, when it did, and its duration.
      wantedMs: r(info.wantedMs ?? t), plannedMs: r(info.plannedMs), startMs: r(t), durMs: r(dur),
      // The sound it is timed against ('onset', 'end', or 'now' for none), when it was expected to be heard here,
      // and which moment of the movement is meant to meet it ('start' or 'end').
      aim: info.aim, soundMs: r(info.soundMs), key: info.key ?? null, onsetExact: info.onsetExact ?? null,
      offsetMs: r(info.offsetMs), lagMs: r(info.lagMs), extraMs: r(info.extraMs), inPlaceMs: null, bodyLagMs: null,
    };
    if (info.shiftMs !== undefined) {                       // a re-timing
      rec.shiftMs = r(info.shiftMs);                        // how much later (+) or earlier (−) the movement now ends
      rec.span = info.span; rec.commandInPlaceMs = r(info.commandInPlaceMs);
    }
    this.moves.push(rec);
    this.open = this.open.filter((o) => o.channel !== rec.channel);
    if ((rec.span ?? Math.abs(to - from)) >= 0.1) this.open.push(rec);   // a movement of less than a tenth of its span has no body lag to speak of
  }
}
