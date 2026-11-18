// The kinesics realizer against made-up turn cue messages (no bot, no audio, no body).
// Times: the bot's clock equals the local clock here, and the tracker's sound lag is set to 0,
// so a sound announced for 5000 ms is heard at 5000 ms.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CueTracker } from '../src/turn-cues.js';
import { KinesicsRealizer, MIN_FACTOR } from '../src/kinesics/kinesics-realizer.js';

const PROFILES = JSON.parse(readFileSync(new URL('../src/kinesics/profiles.json', import.meta.url)));
const P = PROFILES.profiles.video_call, S = P.speaking, B = PROFILES.body;
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);

function setup(opts = {}) {
  const tracker = new CueTracker({ lagMs: 0, learnLag: false });
  const real = new KinesicsRealizer(PROFILES, { liveliness: false, ...opts });
  let rev = 0;
  const send = (now, fields) => { tracker.observe({ type: 'bot-turn-cue', v: 1, now_ms: now, turn: 1, rev: ++rev, text_started: true, onset_exact: true, segments: [], end_ms: null, words: null, ...fields }, now); real.plan(tracker, now, 0); };
  let t = 0, last = null; const log = [];
  const run = (until, each) => { for (; t <= until; t += 10) { last = real.sample(t); log.push([t, last]); each?.(last, t); } return last; };
  return { tracker, real, send, run, log };
}

// A reply of 6 s whose first sound is heard at 5000 ms, announced 800 ms ahead, with one pause from 7000 to 7600 ms.
function longReply(x) {
  x.run(4200);
  x.send(4200, { status: 'preparing', onset_ms: 5000, onset_exact: false });
  x.run(4900);
  x.send(4900, { status: 'speaking', onset_ms: 5000, segments: [{ start_ms: 5000, end_ms: null }] });
  x.run(5300);
  x.send(5300, { status: 'speaking', onset_ms: 5000, segments: [{ start_ms: 5000, end_ms: 7000 }, { start_ms: 7600, end_ms: null }] });
  x.run(5400);
  x.send(5400, { status: 'speaking', onset_ms: 5000, segments: [{ start_ms: 5000, end_ms: 7000 }, { start_ms: 7600, end_ms: 11000 }], end_ms: 11000 });
}

test('listening: the body faces the partner at rest', () => {
  const x = setup();
  const s = x.run(1000);
  assert.equal(s.gaze.eyes, 0); assert.equal(s.headYawDeg, 0); assert.equal(s.handTl, 0);
  assert.equal(s.speedDps, P.listening.head_speed_dps);
});

test('bid: eyes and head leave the partner around the first sound, with a dip, a blink and the hand after it', () => {
  const x = setup(); longReply(x);
  let blinkAt = NaN, lowest = 0, lowestAt = 0;
  x.run(5600);
  for (const [t, s] of x.log) {
    if (t <= 4290) assert.equal(s.gaze.eyes, 0, 'nothing moves before the look away starts, 700 ms ahead');
    if (s.blink > 0.9 && t >= 4900 && !(blinkAt > 0)) blinkAt = t;
    if (s.headPitchDeg < lowest) { lowest = s.headPitchDeg; lowestAt = t; }
  }
  near(blinkAt, 5000 + PROFILES.blink.closed_ms / 2, 30, 'the bid blink is closed just after the first sound');
  near(lowest, S.head_pitch_deg + P.bid.dip_deg, 0.05, 'chin dip');
  near(lowestAt, 5000 + P.bid.dip_peak_ms, 30, 'when the dip is lowest');
  const at300 = x.real.sample(5600);
  near(at300.headYawDeg, S.head_away_deg, 0.1, 'head away');
  assert.ok(x.real.ch.eyes.value(4300 + 400) > 0.99, 'the eyes are away 400 ms after they start, before the head');
  assert.ok(x.real.ch.hand.value(5000) < 0.05, 'the hand is still down at the first sound');
  near(x.real.ch.hand.value(5700) * B.hand.rise_tl, B.hand.rise_tl, 0.01, 'hand raised 0.7 s after the first sound');
});

test('speaking: glances back at the partner take about the measured share of the time', () => {
  const x = setup();
  x.send(0, { status: 'speaking', onset_ms: 1000, segments: [{ start_ms: 1000, end_ms: null }] });
  let on = 0, n = 0;
  x.run(61000, (s, t) => { if (t > 2000) { n++; if (s.gaze.eyes < 0.5) on++; } });
  near(on / n, S.partner_share, 0.06, 'share of time with the eyes on the partner');
});

test('pause: the gaze stays away, the head slows and the chin rises; all of it is undone on resuming', () => {
  const x = setup(); longReply(x);
  const s = x.run(7000);
  near(s.speedDps, S.head_speed_dps * P.pause.speed_factor, 0.05, 'head speed at the pause');
  near(s.headPitchDeg, S.head_pitch_deg + P.pause.chin_rise_deg, 0.05, 'chin at the pause');
  x.run(7550, (q) => assert.equal(q.gaze.head, 1, 'the head stays away through the pause'));
  assert.ok(s.handTl > 0.29, 'the hand stays up');
  const r = x.run(7600 + P.pause.resume_ms);
  near(r.speedDps, S.head_speed_dps, 0.05, 'head speed after resuming');
});

test('yield: the eyes are back before the last sound, the head after it, the hand starts down a second ahead', () => {
  const x = setup(); longReply(x);
  const a = x.run(9990);
  near(a.handTl, B.hand.rise_tl, 0.01, 'hand still up 1 s before the last sound');
  const b = x.run(11000 + P.yield.eyes_return_end_ms);
  assert.ok(b.gaze.eyes < 0.01, 'eyes on the partner 0.1 s before the last sound');
  assert.ok(b.gaze.head > 0.9, 'the head has hardly started back');
  assert.ok(b.handTl < a.handTl * 0.6, 'the hand is on its way down');
  const c = x.run(11000 + P.yield.head_return_end_ms);
  assert.ok(c.gaze.head < 0.01, 'head on the partner 0.7 s after the last sound'); assert.ok(c.handTl < 0.005, 'hand at rest');
  near(c.headPitchDeg, P.yield.head_pitch_deg, 0.05, 'chin up after the yield');
  const d = x.run(11000 + P.yield.settle_end_ms);
  near(d.speedDps, P.listening.head_speed_dps, 0.05, 'the head has settled');
  near(x.run(15000).headPitchDeg, 0, 0.01, 'and relaxes to the listening posture');
});

test('a reply known to be short keeps facing the partner and keeps the hand down', () => {
  const x = setup();
  x.send(4500, { status: 'speaking', onset_ms: 5000, segments: [{ start_ms: 5000, end_ms: 5600 }], end_ms: 5600 });
  x.run(7000, (s) => { assert.ok(s.gaze.eyes < 0.01 && s.gaze.head < 0.01); assert.equal(s.handTl, 0); });
});

test('a reply that turns out short after the look away began returns with its yield', () => {
  const x = setup();
  x.send(4200, { status: 'preparing', onset_ms: 5000, onset_exact: false });
  x.run(4700);
  assert.ok(x.real.ch.eyes.value(4700) > 0.9);
  x.send(4700, { status: 'speaking', onset_ms: 5000, segments: [{ start_ms: 5000, end_ms: 5500 }], end_ms: 5500 });
  const s = x.run(6300);
  assert.ok(s.gaze.eyes < 0.01 && s.gaze.head < 0.01);
});

test('cancelled and interrupted: back to listening at once', () => {
  for (const status of ['cancelled', 'interrupted']) {
    const x = setup(); longReply(x);
    x.run(6000);
    x.send(6000, { status, onset_ms: 5000, end_ms: status === 'interrupted' ? 6000 : null });
    const s = x.run(6500);
    assert.ok(s.gaze.eyes < 0.01 && s.gaze.head < 0.01 && s.handTl < 0.005, status);
    near(s.speedDps, P.listening.head_speed_dps, 0.05, status);
    x.run(9000, (q) => assert.ok(q.gaze.eyes < 0.01, 'no glance or pause movement follows a stopped reply'));
  }
});

test('a late cue: the movement starts at once, faster, and no faster than 2/3 of its normal duration', () => {
  const x = setup();
  x.send(0, { status: 'speaking', onset_ms: 1000, segments: [{ start_ms: 1000, end_ms: null }] });
  x.run(4750); x.real.take();
  // The end, 5000 ms, becomes known only 250 ms ahead: the eyes should have started back 350 ms earlier.
  x.send(4750, { status: 'speaking', onset_ms: 1000, segments: [{ start_ms: 1000, end_ms: 5000 }], end_ms: 5000 });
  x.run(4770);
  const mv = x.real.take().find((m) => m.kind === 'eyes-return');
  near(mv.startMs, 4750, 11, 'starts at once');
  const normal = P.yield.eyes_return_end_ms - P.yield.eyes_return_start_ms;
  near(mv.durMs, normal * MIN_FACTOR, 1, 'at the fastest allowed');
});

test('liveliness: the small head motion runs at the speed asked for and stays near the partner', () => {
  for (const setting of ['video_call', 'same_room']) {
    const real = new KinesicsRealizer(PROFILES, { setting });
    const L = PROFILES.profiles[setting].listening;
    let prev = null, path = 0; const off = [];
    for (let t = 0; t <= 120000; t += 20) {
      const s = real.sample(t);
      if (prev) path += Math.hypot(s.headYawDeg - prev.headYawDeg, s.headPitchDeg - prev.headPitchDeg);
      off.push(Math.hypot(s.headYawDeg, s.headPitchDeg)); prev = s;
    }
    off.sort((a, b) => a - b);
    near(path / 120, L.head_speed_dps, L.head_speed_dps * 0.1, `${setting}: mean head speed while listening`);
    near(off[off.length >> 1], L.head_scatter_deg, 0.6, `${setting}: median angle from the partner`);
  }
});

test('the same seed gives the same glances', () => {
  const trace = () => { const x = setup({ seed: 7 }); longReply(x); const out = []; x.run(12000, (s) => out.push(s.gaze.eyes)); return out; };
  assert.deepEqual(trace(), trace());
});

test('a body whose head is its only gaze: the head returns with the eyes, and nothing ever jumps', () => {
  const x = setup({ headReturnsWithEyes: true }); longReply(x);
  const b = x.run(11000 + P.yield.eyes_return_end_ms);
  assert.ok(b.gaze.head < 0.01, 'head on the partner 0.1 s before the last sound');
  // An interruption in the middle of a glance: every channel leaves from where it is.
  const y = setup({ headReturnsWithEyes: true });
  y.send(0, { status: 'speaking', onset_ms: 1000, segments: [{ start_ms: 1000, end_ms: null }] });
  let t = 0; while (t < 20000 && !(y.real.ch.eyes.value(t) < 0.05 && y.real.ch.head.value(t) > 0.95)) { y.run(t); t += 10; }
  assert.ok(t < 20000, 'a glance happened');
  y.send(t, { status: 'interrupted', onset_ms: 1000, end_ms: t });
  let prev = null;
  y.run(t + 1000, (s) => { if (prev) assert.ok(Math.abs(s.gaze.head - prev.gaze.head) < 0.06 && Math.abs(s.gaze.eyes - prev.gaze.eyes) < 0.1, 'no jump'); prev = s; });
});

// ---- the mouth: the resting posture under the lip movement ----
const M = P.mouth;

test('mouth, long reply told early: a quarter open and half open at the two measured moments, then a small opening under the speech', () => {
  const x = setup();
  x.run(3500);
  x.send(3500, { status: 'preparing', onset_ms: 5000, onset_exact: false });
  assert.equal(x.run(5000 + 2 * M.quarter_open_ms - M.half_open_ms - 10).mouth, 0, 'closed before the run-up');
  near(x.run(5000 + M.quarter_open_ms).mouth, M.open / 2, 0.02, 'a quarter open');
  near(x.run(5000 + M.half_open_ms).mouth, M.open, 0.01, 'half open');
  near(x.run(5000 + M.floor_end_ms).mouth, M.speaking_floor, 0.01, 'resting opening while speaking');
  const open = x.real.take().find((m) => m.kind === 'mouth-open');
  near(open.startMs + open.durMs, 5000 + M.half_open_ms, 10, 'the opening ends at its measured moment');
});

test('mouth, pause and end: half open through a short pause, closed with the last sound', () => {
  const x = setup();
  longReply(x);
  near(x.run(7000 + M.pause_open_ms + 20).mouth, M.open, 0.01, 'half open in the pause');
  near(x.run(7590).mouth, M.open, 0.01, 'still half open before resuming');
  near(x.run(7600 + M.floor_end_ms).mouth, M.speaking_floor, 0.01, 'back to the speaking opening');
  near(x.run(11000 + M.close_end_ms + 20).mouth, 0, 0.01, 'closed after the last sound');
});

test('mouth, long pause: the mouth closes after the first second and opens again before resuming', () => {
  const x = setup();
  x.run(4000);
  x.send(4000, { status: 'speaking', onset_ms: 5000, segments: [{ start_ms: 5000, end_ms: 6000 }] });
  near(x.run(6000 + M.pause_hold_ms - 20).mouth, M.open, 0.01, 'half open for the first second');
  near(x.run(6000 + M.pause_hold_ms + M.pause_close_ms + 20).mouth, 0, 0.01, 'then closed');
  x.send(x.log.at(-1)[0], { status: 'speaking', onset_ms: 5000, segments: [{ start_ms: 5000, end_ms: 6000 }, { start_ms: 9000, end_ms: null }] });
  near(x.run(9000 + M.resume_end_ms + 10).mouth, M.open, 0.01, 'open again just before resuming');
});

test('mouth, short reply: opens late', () => {
  const x = setup();
  x.run(4000);
  x.send(4000, { status: 'speaking', onset_ms: 5000, segments: [{ start_ms: 5000, end_ms: 5600 }], end_ms: 5600 });
  assert.equal(x.run(5000 + M.short_half_open_ms - M.short_open_dur_ms - 10).mouth, 0, 'still closed 0.3 s before the sound');
  near(x.run(5000 + M.short_half_open_ms).mouth, M.open, 0.01, 'half open just before the sound');
  assert.ok(x.real.take().some((m) => m.kind === 'mouth-open-short'));
});

test('mouth, cancelled: an opening under way closes again', () => {
  const x = setup();
  x.run(4200);
  x.send(4200, { status: 'preparing', onset_ms: 5000, onset_exact: false });
  assert.ok(x.run(4500).mouth > 0.1, 'opening');
  x.send(4500, { status: 'cancelled' });
  near(x.run(5100).mouth, 0, 0.01, 'closed again');
});

test('mouth, readiness: a quarter open on the first word that a reply is being prepared, half open on time once the sound is known', () => {
  const x = setup();
  x.run(3000);
  x.send(3000, { status: 'preparing', text_started: false, onset_ms: null, onset_exact: false });
  near(x.run(3000 + M.ready_dur_ms + 10).mouth, M.ready_open, 0.01, 'a quarter open');
  assert.equal(x.log.at(-1)[1].gaze.eyes, 0, 'the eyes have not moved');
  near(x.run(4100).mouth, M.ready_open, 0.01, 'held');
  x.send(4100, { status: 'preparing', onset_ms: 5000, onset_exact: false });
  near(x.run(5000 + M.half_open_ms).mouth, M.open, 0.01, 'half open at the measured moment');
  const open = x.real.take().find((m) => m.kind === 'mouth-open');
  near(open.durMs, M.half_open_ms - M.quarter_open_ms, 1, 'the second half of the run-up at its normal speed');
});

test('mouth, readiness: a reply dropped before its first text closes the mouth again', () => {
  const x = setup();
  x.run(3000);
  x.send(3000, { status: 'preparing', text_started: false, onset_ms: null, onset_exact: false });
  assert.ok(x.run(3200).mouth > 0.1);
  x.send(3200, { status: 'cancelled', text_started: false, onset_ms: null, onset_exact: false });
  near(x.run(3800).mouth, 0, 0.01, 'closed again');
});
