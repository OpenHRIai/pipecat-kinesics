// The kinesics realizer: turns the bot's announced turn (src/turn-cues.js, turn-cue-protocol.md) into
// what a body shows of it with head, eyes, one hand and torso lean.  It is body-neutral: sample(t)
// returns angles and heights, and an adapter per body (the avatar, the G1) turns those into bones or
// joints.  Every number comes from a profile (profiles.json; kinesics-profiles.md says where each is from).
//
// What it does, against the bot's sound as this client hears it (video_call values):
//
//   listening   faces the partner; the head drifts slowly
//   bid         the mouth opens first: a quarter open as soon as the bot says a reply is being prepared (or
//               0.7 to 0.8 s before the first sound, if that is known in time) and half open 0.4 s before the first
//               sound of a long reply (0.1 s before a short one);
//               looks away from 0.7 s before the first sound; the head starts moving 0.5 s before, dips a
//               little and blinks at the first sound; the hand rises with the first words
//   speaking    head and eyes away, with glances back at the partner for the measured share of the time
//   pause       the mouth stays half open for the first second, then closes; keeps looking away; the head slows from 0.7 s before the pause and the chin rises a little
//   yield       the mouth closes with the last sound; the eyes return just before the last sound, the head follows through the next 0.7 s and
//               settles; the hand starts down 1 s before the last sound
//   cancelled, interrupted   back to listening at once
//
// A reply known to be shorter than away_min_reply_ms keeps facing the partner and keeps the hand down.
//
// Each quantity is a channel that moves on a smooth curve (minimum jerk) from wherever it is to where it
// should be.  A movement is planned with the moment it should start and the moment it should be done.
// When a cue arrives too late for that, the movement starts at once and is made faster, down to 2/3 of
// its normal duration; later still it finishes late (the rule of the G1 turn realizer).
//
// Chosen here, not measured (also listed in kinesics-profiles.md):
//   EYE_SHIFT_MS      how long the eyes take to leave or reach the partner at a glance
//   glances are made with the eyes; the head stays where it is
//   after the yield, pitch and lean drift back to the listening posture over RELAX_MS

export const MIN_FACTOR = 2 / 3;
export const EYE_SHIFT_MS = 200;
export const RELAX_MS = 2000;
const END_STATUS = new Set(['cancelled', 'interrupted']);

const smooth = (s) => (s <= 0 ? 0 : s >= 1 ? 1 : s * s * s * (10 - 15 * s + 6 * s * s));

class Channel {
  constructor(v = 0) { this.from = v; this.to = v; this.start = -Infinity; this.dur = 1; }
  value(t) { return t <= this.start ? this.from : this.from + (this.to - this.from) * smooth((t - this.start) / this.dur); }
  go(to, t, dur) { this.from = this.value(t); this.to = to; this.start = t; this.dur = Math.max(dur, 1); }
}

// The small continuous head motion: two slow sums of sines, walked through at a rate set by the speed
// wanted.  NOISE_SPEED is the mean angular speed of the pattern per unit of phase and NOISE_MEDIAN its
// median distance from the centre, both for an amplitude of 1 degree; found numerically once.
const noiseYaw = (p) => Math.sin(p) + 0.5 * Math.sin(2.3 * p + 1.0);
const noisePitch = (p) => 0.6 * Math.sin(0.8 * p + 2.0) + 0.3 * Math.sin(1.9 * p);
const [NOISE_SPEED, NOISE_MEDIAN] = (() => {
  const d = 0.001, n = 200000, r = []; let s = 0;
  for (let i = 0; i < n; i++) {
    const p = i * d;
    s += Math.hypot(noiseYaw(p + d) - noiseYaw(p), noisePitch(p + d) - noisePitch(p)) / d;
    if (i % 20 === 0) r.push(Math.hypot(noiseYaw(p), noisePitch(p)));
  }
  r.sort((a, b) => a - b);
  return [s / n, r[r.length >> 1]];
})();

function rng(seed) {   // small seeded generator, so a session's glances and blinks can be repeated
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}

export class KinesicsRealizer {
  /**
   * @param profiles  the parsed profiles.json
   * @param opts.setting     'video_call' or 'same_room'
   * @param opts.side        +1 or -1: the side the body looks away to
   * @param opts.livelinessScale  makes the small continuous motion smaller and slower by this factor (a heavy body)
   * @param opts.headReturnsWithEyes  at the yield the head returns on the eyes' timing (a body whose head is its only gaze)
   * @param opts.liveliness  false switches the small continuous head motion off (tests, and bodies that add their own)
   * @param opts.seed        for the timing of glances and blinks
   */
  constructor(profiles, { setting = 'video_call', side = 1, liveliness = true, livelinessScale = 1, headReturnsWithEyes = false, seed = 1 } = {}) {
    this.p = profiles.profiles[setting];
    if (!this.p) throw new Error(`kinesics: no profile '${setting}'`);
    this.body = profiles.body; this.blinkP = profiles.blink;
    this.setting = setting; this.side = side; this.liveliness = liveliness; this.livelinessScale = livelinessScale; this.headReturnsWithEyes = headReturnsWithEyes; this.seed = seed;
    this.reset();
  }

  reset() {
    const L = this.p.listening;
    this.ch = {
      eyes: new Channel(0),             // 0 = on the partner, 1 = away
      head: new Channel(0),             // the same for the head
      pitch: new Channel(0),            // degrees, chin up positive
      speed: new Channel(L.head_speed_dps),   // how lively the head is, degrees per second
      hand: new Channel(0),             // 0 = at rest, 1 = raised by body.hand.rise_tl
      lean: new Channel(0),             // degrees, towards the partner positive
      mouth: new Channel(0),            // the resting mouth posture under the lip movement: 0 = closed, 1 = the usual opening while speaking
    };
    this.planned = new Map();           // name -> { channel, to, at, doneBy, normal }
    this.done = new Set();
    this.turn = 0;
    this.moves = [];                    // movements started, for the report; drained by take()
    this.rand = rng(this.seed);
    this.window = null;                 // while speaking and away: { from, until } in which glances may fall
    this.nextGlance = NaN;
    this.blinks = [];                   // start times of blinks still to come or under way
    this.nextBlink = NaN; this.blinkFactor = 1; this.blinkFactorUntil = -Infinity;
    this.phase = this.rand() * 100; this.lastT = NaN;
  }

  /**
   * Plan the movements for the newest state of the bot's turn.  Call on every new state.
   * @param tracker  a CueTracker
   * @param now      local time (performance.now())
   * @param extraMs  what this client adds after the point where it hears the sound (src/turn-cues.js)
   */
  plan(tracker, now, extraMs = 0) {
    const m = tracker.state;
    if (!m || m.turn === 0) return;
    if (m.turn !== this.turn) { this.turn = m.turn; this.done.clear(); this.planned.clear(); this.window = null; }
    const P = this.p, B = this.body, L = P.listening, S = P.speaking;
    const heard = (ms) => tracker.heardAt(ms, extraMs);
    const onset = heard(m.onset_ms), end = heard(m.end_ms);
    this.info = { turn: m.turn, rev: m.rev };

    if (END_STATUS.has(m.status)) {
      this.planned.clear(); this.window = null;
      if (!this.done.has('stop')) {
        this.done.add('stop');
        const dur = m.status === 'cancelled' ? 500 : 400;
        for (const [name, to] of [['eyes', 0], ['head', 0], ['pitch', 0], ['speed', L.head_speed_dps], ['hand', 0], ['lean', 0], ['mouth', 0]]) this._start(m.status, name, to, now, dur, now);
      }
      return;
    }
    // The mouth alone moves on the bot's first word that a reply is being prepared, before its first text and
    // before any time for its sound is known: a quarter open at once, as a readiness posture.  It needs about a
    // second of run-up, which the first text does not leave.  A reply dropped at this stage closes it again.
    const M = P.mouth;
    if (M?.ready_on_preparing && m.status === 'preparing' && !m.text_started && !this.done.has('mouth-ready')) {
      this._plan('mouth-ready', 'mouth', M.ready_open, now, now + M.ready_dur_ms, M.ready_dur_ms, now, NaN);
    }
    if (!Number.isFinite(onset) || !(m.text_started || m.onset_exact)) return;
    const textAt = tracker.textAt.get(m.turn) ?? now;
    const notBeforeText = (t) => Math.max(t, textAt);
    const long = !Number.isFinite(end) || end - onset >= S.away_min_reply_ms;
    const handLong = !Number.isFinite(end) || end - onset >= B.hand.min_reply_ms;
    const b = P.bid;

    // Bid.
    if (long) {
      this._plan('look-away-eyes', 'eyes', 1, notBeforeText(onset + b.look_away_start_ms), onset + b.look_away_start_ms + 2 * EYE_SHIFT_MS, 2 * EYE_SHIFT_MS, now, onset);
      this._plan('look-away-head', 'head', 1, notBeforeText(onset + b.head_move_start_ms), onset + b.look_away_end_ms, b.look_away_end_ms - b.head_move_start_ms, now, onset);
    } else { this.planned.delete('look-away-eyes'); this.planned.delete('look-away-head'); }
    this._plan('dip', 'pitch', S.head_pitch_deg + b.dip_deg, notBeforeText(onset + b.head_move_start_ms), onset + b.dip_peak_ms, b.dip_peak_ms - b.head_move_start_ms, now, onset);
    this._plan('undip', 'pitch', S.head_pitch_deg, onset + b.dip_peak_ms, onset + b.dip_end_ms, b.dip_end_ms - b.dip_peak_ms, now, onset);
    this._plan('liven', 'speed', S.head_speed_dps * b.speed_peak_factor, notBeforeText(onset + b.head_move_start_ms), onset + b.speed_peak_ms, b.speed_peak_ms - b.head_move_start_ms, now, onset);
    this._plan('liven-settle', 'speed', S.head_speed_dps, onset + b.speed_peak_ms, onset + b.speed_peak_ms + 500, 500, now, onset);
    this._plan('lean-away', 'lean', B.torso_lean.speaking_deg, onset + B.torso_lean.bid_start_ms, onset + B.torso_lean.bid_end_ms, B.torso_lean.bid_end_ms - B.torso_lean.bid_start_ms, now, onset);
    if (handLong) this._plan('hand-up', 'hand', 1, onset + B.hand.rise_start_ms, onset + B.hand.rise_end_ms, B.hand.rise_end_ms - B.hand.rise_start_ms, now, onset);
    else this.planned.delete('hand-up');
    if (!this.done.has('bid-blink')) { this.done.add('bid-blink'); this.bidBlinkAt = onset + b.blink_ms; } else if (this.bidBlinkAt > now) this.bidBlinkAt = onset + b.blink_ms;

    // The mouth opens before the sound: early and gradually for a long reply (a quarter open and half open at
    // the two measured moments, which on this curve are the middle and the end of one movement), late for a
    // short one.  Once the sound is there it rests a little open under the lip movement.
    if (M && !this.done.has('mouth-open') && !this.done.has('mouth-open-short')) {
      const mouthLong = !Number.isFinite(end) || end - onset >= M.min_long_reply_ms;
      // Already a quarter open from the readiness posture: only the second half of the run-up is left.
      const ready = this.done.has('mouth-ready') || this.planned.has('mouth-ready');
      const [name, other, m0, m1] = mouthLong
        ? ['mouth-open', 'mouth-open-short', ready ? M.quarter_open_ms : M.half_open_ms - 2 * (M.half_open_ms - M.quarter_open_ms), M.half_open_ms]
        : ['mouth-open-short', 'mouth-open', M.short_half_open_ms - M.short_open_dur_ms, M.short_half_open_ms];
      this.planned.delete(other);
      this._plan(name, 'mouth', M.open, notBeforeText(onset + m0), onset + m1, m1 - m0, now, onset);
    }
    if (M) this._plan('mouth-speak', 'mouth', M.speaking_floor, onset + M.floor_start_ms, onset + M.floor_end_ms, M.floor_end_ms - M.floor_start_ms, now, onset);

    // Pauses: every closed segment that is not the end of the reply.
    const segs = m.segments ?? [], pz = P.pause;
    segs.forEach((seg, i) => {
      if (seg.end_ms === null || seg.end_ms === undefined) return;
      if (m.end_ms !== null && m.end_ms !== undefined && seg.end_ms >= m.end_ms - 1) return;
      const g0 = heard(seg.end_ms);
      this._plan(`pause-${i}-slow`, 'speed', S.head_speed_dps * pz.speed_factor, g0 + pz.slow_start_ms, g0, -pz.slow_start_ms, now, g0);
      this._plan(`pause-${i}-chin`, 'pitch', S.head_pitch_deg + pz.chin_rise_deg, g0 + pz.slow_start_ms, g0, -pz.slow_start_ms, now, g0);
      const next = segs[i + 1];
      if (M) {
        // Half open through the first second of a pause; a longer pause closes the mouth, and it opens again before resuming.
        const r1 = next ? heard(next.start_ms) : NaN, closes = !Number.isFinite(r1) || r1 - g0 > M.pause_hold_ms + M.pause_close_ms;
        this._plan(`pause-${i}-mouth`, 'mouth', M.open, g0, g0 + M.pause_open_ms, M.pause_open_ms, now, g0);
        if (closes) this._plan(`pause-${i}-mouth-close`, 'mouth', 0, g0 + M.pause_hold_ms, g0 + M.pause_hold_ms + M.pause_close_ms, M.pause_close_ms, now, g0);
        else this.planned.delete(`pause-${i}-mouth-close`);
        if (Number.isFinite(r1)) {
          if (closes) this._plan(`resume-${i}-mouth-open`, 'mouth', M.open, r1 + M.resume_start_ms, r1 + M.resume_end_ms, M.resume_end_ms - M.resume_start_ms, now, r1);
          this._plan(`resume-${i}-mouth`, 'mouth', M.speaking_floor, r1 + M.floor_start_ms, r1 + M.floor_end_ms, M.floor_end_ms - M.floor_start_ms, now, r1);
        }
      }
      if (!next) return;
      const g1 = heard(next.start_ms);
      this._plan(`resume-${i}-speed`, 'speed', S.head_speed_dps, g1, g1 + pz.resume_ms, pz.resume_ms, now, g1);
      this._plan(`resume-${i}-dip`, 'pitch', S.head_pitch_deg + pz.resume_dip_deg, g1 - 300, g1 + 300, 600, now, g1);
      this._plan(`resume-${i}-undip`, 'pitch', S.head_pitch_deg, g1 + 300, g1 + 1100, 800, now, g1);
    });

    // Glances fall between the end of the look away and the start of the eyes' return.
    this.window = long ? { from: onset + b.look_away_end_ms + 300, until: Number.isFinite(end) ? end + P.yield.eyes_return_start_ms - S.glance_ms - 2 * EYE_SHIFT_MS : Infinity } : null;

    // Yield.
    if (Number.isFinite(end)) {
      const y = P.yield, h = B.hand, tl = B.torso_lean;
      // A glance still open when the eyes return for good must not send them away again.
      if (this.planned.get('glance-end')?.at >= end + y.eyes_return_start_ms - EYE_SHIFT_MS) this.planned.delete('glance-end');
      this._plan('eyes-return', 'eyes', 0, end + y.eyes_return_start_ms, end + y.eyes_return_end_ms, y.eyes_return_end_ms - y.eyes_return_start_ms, now, end);
      const [h0, h1] = this.headReturnsWithEyes ? [y.eyes_return_start_ms, y.eyes_return_end_ms] : [y.head_return_start_ms, y.head_return_end_ms];
      this._plan('head-return', 'head', 0, end + h0, end + h1, h1 - h0, now, end);
      this._plan('chin-up', 'pitch', y.head_pitch_deg, end + y.pitch_start_ms, end + y.pitch_end_ms, y.pitch_end_ms - y.pitch_start_ms, now, end);
      this._plan('chin-relax', 'pitch', 0, end + y.settle_end_ms, end + y.settle_end_ms + RELAX_MS, RELAX_MS, now, end);
      this._plan('settle', 'speed', L.head_speed_dps, end, end + y.settle_end_ms, y.settle_end_ms, now, end);
      this._plan('hand-down', 'hand', 0, end + h.lower_start_ms, end + h.lower_end_ms, h.lower_end_ms - h.lower_start_ms, now, end);
      this._plan('lean-back', 'lean', tl.yield_deg, end + tl.yield_start_ms, end + tl.yield_end_ms, tl.yield_end_ms - tl.yield_start_ms, now, end);
      if (M) this._plan('mouth-close', 'mouth', 0, end + M.close_start_ms, end + M.close_end_ms, M.close_end_ms - M.close_start_ms, now, end);
      this._plan('lean-relax', 'lean', 0, end + y.settle_end_ms, end + y.settle_end_ms + RELAX_MS, RELAX_MS, now, end);
      this.blinkFactor = y.blink_rate_factor; this.blinkFactorFrom = end; this.blinkFactorUntil = end + RELAX_MS;
    }
  }

  /**
   * What the body shows at local time t.  Call with rising t (once per frame or control tick).
   * Angles in degrees from the direction towards the partner: yaw positive to this.side, pitch positive chin up.
   */
  sample(t) {
    // Start planned movements now due, earliest first.
    if (this.planned.size) {
      for (const [name, q] of [...this.planned].sort((a, b) => a[1].at - b[1].at)) {
        if (q.at > t) break;
        this.planned.delete(name);
        const dur = Math.max(q.normal * MIN_FACTOR, Math.min(q.normal, q.doneBy - t));
        this._start(name, q.channel, q.to, t, dur, q.at, q.soundMs);
      }
    }
    // Glances back at the partner while speaking and away.
    const S = this.p.speaking, w = this.window;
    if (w && t >= w.from && t < w.until && this.ch.eyes.to === 1) {
      const period = S.glance_ms / S.partner_share;
      if (!Number.isFinite(this.nextGlance) || this.nextGlance < w.from) this.nextGlance = Math.max(t, w.from) + (period - S.glance_ms) * (0.5 + this.rand());
      if (t >= this.nextGlance) {
        const at = this.nextGlance;
        this._start('glance', 'eyes', 0, t, EYE_SHIFT_MS, at);
        this.planned.set('glance-end', { channel: 'eyes', to: 1, at: at + S.glance_ms, doneBy: at + S.glance_ms + EYE_SHIFT_MS, normal: EYE_SHIFT_MS });
        this.nextGlance = at + S.glance_ms + (period - S.glance_ms) * (0.5 + this.rand());
      }
    } else if (!w) this.nextGlance = NaN;

    // Blinks: one at the bid, the others at a steady average rate.
    if (Number.isFinite(this.bidBlinkAt) && t >= this.bidBlinkAt) { this.blinks.push(Math.max(this.bidBlinkAt, t - 1000 / 60)); this.bidBlinkAt = NaN; }
    const factor = t >= this.blinkFactorFrom && t < this.blinkFactorUntil ? this.blinkFactor : 1;
    if (!Number.isFinite(this.nextBlink)) this.nextBlink = t + (60000 / this.blinkP.rate_per_min) * (0.5 + this.rand());
    if (t >= this.nextBlink) { this.blinks.push(t); this.nextBlink = t + (60000 / (this.blinkP.rate_per_min * factor)) * (0.5 + this.rand()); }
    const c = this.blinkP.closed_ms;
    this.blinks = this.blinks.filter((b0) => t - b0 < c);
    let blink = 0;
    for (const b0 of this.blinks) blink = Math.max(blink, 1 - Math.abs(2 * (t - b0) / c - 1));

    // The small continuous head motion, at the speed the speed channel asks for.
    const v = this.ch, speed = v.speed.value(t), amp = this.p.listening.head_scatter_deg / NOISE_MEDIAN;
    if (Number.isFinite(this.lastT) && t > this.lastT) this.phase += speed * Math.min(t - this.lastT, 100) / 1000 / (amp * NOISE_SPEED);
    this.lastT = t;
    const k = this.liveliness ? amp * this.livelinessScale : 0, ny = k * noiseYaw(this.phase), np = k * noisePitch(this.phase);

    const eyes = v.eyes.value(t), head = v.head.value(t);
    return {
      headYawDeg: this.side * head * S.head_away_deg + ny,
      headPitchDeg: v.pitch.value(t) + np,
      eyeYawDeg: this.side * eyes * S.eye_away_deg,     // in the head: the eyes' own turn on top of the head's
      eyePitchDeg: 0,
      blink,                                            // 0 = open, 1 = closed
      handTl: v.hand.value(t) * this.body.hand.rise_tl, // torso lengths above rest
      hand: v.hand.value(t),                            // the same as a share: 0 = at rest, 1 = raised
      torsoLeanDeg: v.lean.value(t),
      mouth: v.mouth.value(t),                          // resting mouth posture: 0 = closed, 1 = the usual opening while speaking
      speedDps: speed,
      gaze: { eyes, head },                             // 0 = on the partner, 1 = away
      liveYawDeg: ny, livePitchDeg: np,                 // the small continuous motion's part of the head angles
    };
  }

  /** Movements started since the last call, for the report to the recorder. */
  take() { return this.moves.splice(0); }

  _plan(name, channel, to, at, doneBy, normal, now, soundMs) {
    if (this.done.has(name) || !Number.isFinite(at)) return;
    this.planned.set(name, { channel, to, at: Math.max(at, now), wanted: at, doneBy: Math.max(doneBy, at), normal: Math.max(normal, 1), soundMs });
  }

  _start(name, channel, to, t, dur, wanted, soundMs) {
    this.done.add(name);
    const ch = this.ch[channel], from = ch.value(t);
    ch.go(to, t, dur);
    const r = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
    this.moves.push({ kind: name, channel, turn: this.info?.turn ?? null, rev: this.info?.rev ?? null,
      from: Math.round(from * 1000) / 1000, to, wantedMs: r(wanted), startMs: r(t), durMs: r(dur), soundMs: r(soundMs) });
  }
}
