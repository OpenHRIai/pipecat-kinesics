// The turn cue client: the clock relation (src/turn-cues.js), the movement timing rules
// (src/robot/turn-realizer.js), and the realizer driving the simulated G1 through the robot loop.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CueTracker } from '../src/turn-cues.js';
import { keyPoses, MOVE_MS, TurnRealizer } from '../src/robot/turn-realizer.js';
import { RobotLoop } from '../src/robot/robot-loop.js';
import { loadAll } from './helpers.mjs';

// The bot's clock runs 5,000 ms behind the page's, and messages take 30 ms: offset 5,030 ms.
const OFFSET = 5030, AUDIO_DELAY = 80;
const msg = (o) => ({ type: 'bot-turn-cue', v: 1, turn: 1, text_started: false, onset_ms: null, onset_exact: false,
  segments: [], end_ms: null, words: null, ...o });
/** Local arrival of a message sent at bot time now_ms, `late` ms after the usual transit. */
const at = (m, late = 0) => m.now_ms + OFFSET + late;

/** A small stand-in for the G1's key poses: joint 0 is an arm, joint 1 the waist turn. */
const toyPoses = () => ({ rest: Float64Array.of(0, 0), ready: Float64Array.of(1, 0), turn: Float64Array.of(0, 0.2) });

/** Feed messages to a tracker and realizer, ticking every 20 ms.  Returns the arm and torso value per tick. */
function run(messages, untilMs, { realizer = new TurnRealizer(toyPoses()), tracker = new CueTracker({ lagMs: 0 }) } = {}) {
  const queue = messages.map(([m, late]) => ({ m, t: at(m, late) })).sort((a, b) => a.t - b.t);
  const trace = [];
  for (let t = queue[0].t; t <= untilMs; t += 20) {
    while (queue.length && queue[0].t <= t) { const { m, t: arr } = queue.shift(); if (tracker.observe(m, arr)) realizer.plan(tracker, arr, AUDIO_DELAY); }
    const q = realizer.target(t);
    trace.push({ t, arms: q[0], torso: q[1] / 0.2 });
  }
  return { trace, realizer, tracker, moves: realizer.take() };
}
const valueAt = (trace, t) => trace.reduce((best, r) => (Math.abs(r.t - t) < Math.abs(best.t - t) ? r : best));

test('the offset is the smallest arrival minus send time; a late message does not move it', () => {
  const c = new CueTracker({ lagMs: 0 });
  c.observe(msg({ now_ms: 100, rev: 1, status: 'preparing' }), 100 + OFFSET + 12);
  c.observe(msg({ now_ms: 200, rev: 2, status: 'preparing' }), 200 + OFFSET);
  c.observe(msg({ now_ms: 300, rev: 3, status: 'preparing' }), 300 + OFFSET + 400);
  assert.equal(c.offsetMs, OFFSET);
  assert.equal(c.heardAt(1000, AUDIO_DELAY), 1000 + OFFSET + AUDIO_DELAY);
});

test('turn and rev, not arrival order, decide the current state; repeats are not new', () => {
  const c = new CueTracker();
  assert.equal(c.observe(msg({ now_ms: 100, rev: 2, status: 'speaking' }), 0), true);
  assert.equal(c.observe(msg({ now_ms: 90, rev: 1, status: 'preparing' }), 1), false, 'older state arriving late');
  assert.equal(c.observe(msg({ now_ms: 1100, rev: 2, status: 'speaking' }), 2), false, 'a repeat');
  assert.equal(c.observe(msg({ v: 2, now_ms: 1200, rev: 9, status: 'speaking' }), 3), false, 'unknown version');
  assert.equal(c.state.status, 'speaking');
  assert.equal(c.observe(msg({ turn: 2, now_ms: 1300, rev: 1, status: 'preparing' }), 4), true);
});

test('the sound lag: measured from the sound heard, at start and end alike; a starting value until then', () => {
  const c = new CueTracker({ lagMs: 130 });
  const seg = [{ start_ms: 1000, end_ms: 2000 }, { start_ms: 2300, end_ms: 4000 }];
  c.observe(msg({ now_ms: 900, rev: 1, status: 'speaking', onset_ms: 1000, onset_exact: true, segments: seg }), 900 + OFFSET);
  const LAG = 158;
  assert.equal(c.heardAt(4000), 4000 + OFFSET + 130, 'the starting value, before anything is measured');
  assert.equal(c.heard('on', 1000 + OFFSET + LAG), LAG);
  c.heard('off', 2000 + OFFSET + LAG + 6);
  assert.equal(c.lagLearned, false);
  assert.equal(c.lagMs, 130, 'two measurements are not enough');
  c.heard('on', 2300 + OFFSET + LAG - 4);
  assert.equal(c.lagLearned, true);
  assert.equal(c.lagMs, LAG);
  assert.equal(c.heard('on', 9000 + OFFSET), null, 'a sound far from any announced boundary measures nothing');
  assert.equal(c.heardAt(4000, 37), 4000 + OFFSET + LAG + 37, 'plus what comes after decoding');
  // A client that knows its own lag does not measure, and is trusted at once.
  const robot = new CueTracker({ lagMs: 20, learnLag: false });
  robot.observe(msg({ now_ms: 900, rev: 1, status: 'speaking', onset_ms: 1000, onset_exact: true, segments: seg }), 900 + OFFSET);
  assert.equal(robot.heard('on', 1000 + OFFSET + 90), null);
  assert.equal(robot.clockReady, true);
  assert.equal(robot.heardAt(1000), 1000 + OFFSET + 20);
});

// One reply on the bot's clock: first text at 0, first sound at 1,000 ms, a pause, last sound at 4,000 ms.
const REPLY = [
  [msg({ now_ms: 0, rev: 1, status: 'preparing', text_started: true, onset_ms: 510 })],
  [msg({ now_ms: 700, rev: 2, status: 'speaking', text_started: true, onset_ms: 1000, onset_exact: true, segments: [{ start_ms: 1000, end_ms: null }] })],
  [msg({ now_ms: 1500, rev: 3, status: 'speaking', text_started: true, onset_ms: 1000, onset_exact: true, segments: [{ start_ms: 1000, end_ms: 2000 }, { start_ms: 2300, end_ms: null }] })],
  [msg({ now_ms: 2500, rev: 4, status: 'speaking', text_started: true, onset_ms: 1000, onset_exact: true,
    segments: [{ start_ms: 1000, end_ms: 2000 }, { start_ms: 2300, end_ms: 4000 }], end_ms: 4000, words: 9 })],
  [msg({ now_ms: 4000, rev: 5, status: 'ended', text_started: true, onset_ms: 1000, onset_exact: true,
    segments: [{ start_ms: 1000, end_ms: 2000 }, { start_ms: 2300, end_ms: 4000 }], end_ms: 4000, words: 9 })],
];
const heard = (serverMs) => serverMs + OFFSET + AUDIO_DELAY;

test('a reply: bid in place at the first sound, held through the pause, torso back by the last sound, arms down after it', () => {
  const { trace, moves } = run(REPLY, heard(5000));
  const kinds = moves.map((m) => m.kind);
  assert.deepEqual(kinds, ['bid', 'away', 'back', 'lower']);
  const bid = moves[0];
  // The first estimate (510 ms) said the sound was close, so the bid started at once and fast.
  assert.ok(Math.abs(bid.startMs - at(REPLY[0][0])) <= 20, `bid started ${bid.startMs - at(REPLY[0][0])} ms after the first text arrived`);
  assert.ok(bid.durMs >= MOVE_MS.bid * 2 / 3 - 1 && bid.durMs <= MOVE_MS.bid, `bid took ${bid.durMs} ms`);
  assert.ok(valueAt(trace, heard(1000)).arms > 0.99, 'arms raised at the first sound');
  assert.ok(valueAt(trace, heard(2150)).arms > 0.99, 'arms held through the pause');
  const back = moves[2], lower = moves[3];
  assert.ok(Math.abs(back.startMs - (heard(4000) - 500)) <= 20, `torso back started ${back.startMs - heard(4000)} ms from the last sound`);
  assert.ok(valueAt(trace, heard(4000)).torso < 0.01, 'torso facing the person at the last sound');
  assert.ok(Math.abs(lower.startMs - heard(4000)) <= 20, 'arms start down at the last sound');
  assert.ok(valueAt(trace, heard(4000) + MOVE_MS.lower).arms < 0.01, 'arms at rest 0.5 s after the last sound');
});

test('a bid that is told early enough starts 0.7 s before the first sound, at its normal speed', () => {
  const early = [[msg({ now_ms: 0, rev: 1, status: 'preparing', text_started: true, onset_ms: 1500 })]];
  const { moves } = run(early, heard(2000));
  assert.equal(moves[0].kind, 'bid');
  assert.ok(Math.abs(moves[0].startMs - (heard(1500) - MOVE_MS.bid)) <= 20);
  assert.equal(moves[0].durMs, MOVE_MS.bid);
});

test('a late cue: the movement is made faster, down to 2/3, then starts from wherever the body is', () => {
  // The end becomes known only 200 ms before the last sound, and arrives 100 ms late as well.
  const msgs = [REPLY[0], REPLY[1], [msg({ ...REPLY[3][0], now_ms: 3800 }), 100]];
  const { moves, trace } = run(msgs, heard(5000));
  const back = moves.find((m) => m.kind === 'back');
  assert.ok(Math.abs(back.startMs - at(msgs[2][0], 100)) <= 20, 'torso back starts as soon as the cue arrives');
  assert.ok(Math.abs(back.durMs - MOVE_MS.back * 2 / 3) < 1, `torso back took ${back.durMs} ms`);
  assert.ok(valueAt(trace, back.startMs + back.durMs + 20).torso < 0.01);
});

test('a rising bid is re-timed to the exact first sound: sooner, later, not once in place, not before the clock is trusted', () => {
  // The first text at 0 says the first sound leaves the server at 600 ms, heard here 680 ms after the text
  // arrives (80 ms of audio delay).  So the bid starts at once and takes 680 ms.
  const first = [msg({ now_ms: 0, rev: 1, status: 'preparing', text_started: true, onset_ms: 600 })];
  const exact = (now, onset) => [msg({ now_ms: now, rev: 2, status: 'speaking', text_started: true, onset_ms: onset, onset_exact: true,
    segments: [{ start_ms: onset, end_ms: null }] })];
  const endOf = (arms) => { const r = arms.at(-1); return r.startMs + r.durMs; };
  const armsOf = (r) => ({ ...r, moves: r.moves.filter((m) => m.channel === 'arms') });

  // Sooner: at 300 ms the exact first sound is 150 ms earlier than estimated, 230 ms away.  The 380 ms left
  // would have to run 1.65 times as fast, so they are held to 3/2 and take 253 ms: the arms are in place
  // 23 ms after the sound instead of 150 ms.
  // A tracker that knows its lag, so that its clock is trusted at once.
  const ready = () => ({ tracker: new CueTracker({ lagMs: 0, learnLag: false }) });
  let { moves, trace } = armsOf(run([first, exact(300, 450)], heard(1000), ready()));
  assert.deepEqual(moves.map((m) => m.kind), ['bid', 'bid-retime']);
  assert.ok(Math.abs(endOf(moves) - (heard(450) + 380 / 1.5 - 230)) <= 1, `in place ${endOf(moves) - heard(450)} ms after the sound`);
  assert.ok(Math.abs(moves[1].shiftMs - (380 / 1.5 - 380)) <= 1, `shift ${moves[1].shiftMs} ms`);
  // No jump: the arms are where they were at the moment of the re-timing.
  const before = valueAt(trace, at(exact(300, 450)[0]) - 20).arms, after = valueAt(trace, at(exact(300, 450)[0])).arms;
  assert.ok(after >= before && after - before < 0.1, `arms ${before} then ${after}`);

  // Later: at 300 ms the exact first sound is 100 ms later than estimated.  The 380 ms left are stretched to 480 ms,
  // within 3/2: in place at the sound.
  ({ moves } = armsOf(run([first, exact(300, 700)], heard(1000), ready())));
  assert.equal(moves.at(-1).kind, 'bid-retime');
  assert.ok(Math.abs(endOf(moves) - heard(700)) <= 1);

  // Already in place: the exact time arrives after the bid has finished, and nothing changes.
  ({ moves } = armsOf(run([first, exact(720, 900)], heard(1200), ready())));
  assert.deepEqual(moves.map((m) => m.kind), ['bid']);

  // A clock not yet trusted: the page has not measured its sound lag, so the bid is left alone.
  ({ moves } = armsOf(run([first, exact(300, 450)], heard(1000))));
  assert.deepEqual(moves.map((m) => m.kind), ['bid']);
});

test('a short reply keeps the torso facing the person', () => {
  const short = [[msg({ now_ms: 0, rev: 1, status: 'speaking', text_started: true, onset_ms: 600, onset_exact: true, end_ms: 1200, segments: [{ start_ms: 600, end_ms: 1200 }] })]];
  const { moves } = run(short, heard(2000));
  assert.deepEqual(moves.map((m) => m.kind), ['bid', 'back', 'lower']);
});

test('cancelled and interrupted: arms down and torso back at once', () => {
  for (const [status, ms] of [['cancelled', MOVE_MS.cancel], ['interrupted', MOVE_MS.interrupt]]) {
    const msgs = [REPLY[0], REPLY[1], [msg({ now_ms: 1800, rev: 3, status, text_started: true, onset_ms: 1000, onset_exact: true, end_ms: 1800 })]];
    const { moves, trace } = run(msgs, heard(3000));
    const stop = moves.find((m) => m.kind === (status === 'cancelled' ? 'cancel' : 'interrupt'));
    assert.ok(stop, `${status}: ${moves.map((m) => m.kind)}`);
    assert.ok(Math.abs(stop.startMs - at(msgs[2][0])) <= 20);
    assert.ok(!moves.some((m) => m.kind === 'back' || m.kind === 'lower'), 'no yield after it');
    assert.ok(valueAt(trace, stop.startMs + ms + 20).arms < 0.01);
  }
});

test('the audio fallback: arms up when sound starts, down after 0.8 s of quiet', () => {
  const r = new TurnRealizer(toyPoses());
  let t = 0;
  const step = (loud, ms) => { for (const end = t + ms; t < end; t += 20) { r.audio(t, loud, true); r.target(t); } };
  step(false, 200); step(true, 1000); step(false, 300); step(true, 500); step(false, 1500);
  // The last loud frame is at 1,980 ms, so 0.8 s of quiet ends at 2,780 ms.
  assert.deepEqual(r.take().map((m) => [m.kind, m.startMs]), [['audio-up', 200], ['audio-down', 2780]]);
});

// The pelvis is held, as on the page by default: the simulated robot has no balance control, and standing
// free it leans up to about 5 degrees forward with the arms raised (2 degrees once settled).
test('on the simulated G1: the realizer drives the arms and torso, and each movement reports when it was in place', async () => {
  const { mujoco, model } = await loadAll();
  const robot = new RobotLoop(mujoco, model, { holdPelvis: true });
  const ix = robot.retargeter.ix;
  const realizer = new TurnRealizer(keyPoses(mujoco, model, ix, robot.standJoints));
  robot.cues = realizer;
  const tracker = new CueTracker({ lagMs: 0 });
  const queue = REPLY.map(([m]) => ({ m, t: at(m) }));
  // Start 2 s early so that the limiter's 1 s ease-in is over before the first cue.
  const start = queue[0].t - 2000, end = heard(5200);
  for (let now = start; now <= end; now += 1000 / 60) {
    while (queue.length && queue[0].t <= now) { const { m, t } = queue.shift(); if (tracker.observe(m, t)) realizer.plan(tracker, t, AUDIO_DELAY); }
    robot.advance(now, NaN);
  }
  const moves = realizer.take();
  const lags = moves.map((m) => `${m.kind} ${m.bodyLagMs === null ? 'never' : m.bodyLagMs.toFixed(0) + ' ms'}`);
  console.log(`  body lag (limb in place, after its command was): ${lags.join(', ')}`);
  assert.deepEqual(moves.map((m) => m.kind), ['bid', 'away', 'back', 'lower']);
  for (const m of moves) assert.ok(m.bodyLagMs !== null && m.bodyLagMs < 100, `${m.kind}: ${lags}`);
  assert.equal(robot.stats().cuedTicks > 0, true);
});
