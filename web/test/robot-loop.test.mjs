// The robot view's control loop, run outside the browser on a simulated clock.
// It replays the recorded 12 second gesture stream the way the page would see it:
// pose frames arrive a little ahead of the playhead, and the page is called once
// per screen refresh.  A browser tab that is hidden or busy gives unreliable
// timing, so these numbers are the trustworthy ones for the loop itself.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { RobotLoop } from '../src/robot/robot-loop.js';
import { decodeMotion } from '../src/wire.js';
import { FIXTURES, loadAll } from './helpers.mjs';

const ref = JSON.parse(await fs.readFile(path.join(FIXTURES, 'retarget_reference.json'), 'utf8'));
const FRAME_MS = 40;                       // 25 poses per second on the wire
const toFrames = (bodies) => bodies.map((body, i) =>
  decodeMotion({ seq: i, pts_ms: i * FRAME_MS, dt_ms: FRAME_MS, n: 1, body })[0]);
const scripted = toFrames(ref.stream.body);
const END_MS = (scripted.length - 1) * FRAME_MS;
const DEG = 180 / Math.PI;

/** Drive the loop with page calls at the given times (ms).  Returns every tick's record. */
function replay(robot, callTimes, bufferAheadMs = 200, frames = scripted) {
  const records = [];
  let next = 0;
  for (const now of callTimes) {
    while (next < frames.length && frames[next].pts <= now + bufferAheadMs) robot.push(frames[next++], now);
    const due = robot.advance(now, now);
    if (due) records.push(...robot.log.slice(-due));
  }
  return records;
}
const every = (stepMs, from, to) => Array.from({ length: Math.floor((to - from) / stepMs) + 1 }, (_, i) => from + i * stepMs);
const summarize = (recs) => ({
  ticks: recs.length,
  posed: recs.filter((r) => r.posed).length,
  armRmsDeg: Math.sqrt(recs.reduce((s, r) => s + r.armErrSq, 0) / recs.length) * DEG,
  retargetErrDeg: recs.filter((r) => r.posed).reduce((s, r) => s + r.retargetErrDeg, 0) / recs.filter((r) => r.posed).length,
  saturatedPct: (100 * recs.filter((r) => r.saturated).length) / recs.length,
  limitedPct: (100 * recs.filter((r) => r.limited && !r.engaging).length) / recs.length,
  limitedDeg: Math.max(...recs.filter((r) => !r.engaging).map((r) => r.limitedDeg)),
  engagingDeg: Math.max(0, ...recs.filter((r) => r.engaging).map((r) => r.limitedDeg)),
  maxTiltDeg: Math.max(...recs.map((r) => r.tiltDeg)),
  minHeight: Math.min(...recs.map((r) => r.pelvisHeight)),
  tickMs: recs.reduce((s, r) => s + r.tickMs, 0) / recs.length,
});

test('60 screen refreshes per second: every control tick runs, the robot tracks and stays up', async () => {
  const { mujoco, model } = await loadAll();
  const robot = new RobotLoop(mujoco, model);
  const s = summarize(replay(robot, every(1000 / 60, 0, END_MS)));
  console.log(`  ${s.ticks} ticks, ${robot.dropped} dropped; retargeting error ${s.retargetErrDeg.toFixed(2)} deg; `
    + `arm tracking ${s.armRmsDeg.toFixed(2)} deg RMS; motor at torque limit in ${s.saturatedPct.toFixed(0)}% of ticks; `
    + `limiter changed ${s.limitedPct.toFixed(0)}% of ticks, by at most ${s.limitedDeg.toFixed(1)} deg; `
    + `tilt max ${s.maxTiltDeg.toFixed(2)} deg; ${s.tickMs.toFixed(2)} ms of compute per tick`);
  assert.equal(robot.dropped, 0);
  assert.ok(Math.abs(s.ticks - END_MS / 20) <= 1, `${s.ticks} ticks`);
  assert.ok(s.posed >= s.ticks - 1, `${s.posed} of ${s.ticks} ticks had a pose`);
  assert.ok(s.armRmsDeg < 2, `arm tracking ${s.armRmsDeg} degrees RMS`);
  assert.ok(s.maxTiltDeg < 3 && s.minHeight > 0.74, `tilt ${s.maxTiltDeg} degrees, height ${s.minHeight} m`);
});

test('a slow page (6 calls per second): ticks are dropped, the robot still follows and stays up', async () => {
  const { mujoco, model } = await loadAll();
  const robot = new RobotLoop(mujoco, model);
  const s = summarize(replay(robot, every(1000 / 6, 0, END_MS)));
  console.log(`  ${s.ticks} ticks, ${robot.dropped} dropped; arm tracking ${s.armRmsDeg.toFixed(2)} deg RMS; tilt max ${s.maxTiltDeg.toFixed(2)} deg`);
  assert.equal(robot.dropped, 0, 'gaps of 167 ms are under the 200 ms backlog limit');
  assert.ok(s.maxTiltDeg < 3 && s.minHeight > 0.74);
});

test('a 1 second stall: the backlog is dropped, not replayed', async () => {
  const { mujoco, model } = await loadAll();
  const robot = new RobotLoop(mujoco, model);
  const times = [...every(1000 / 60, 0, 5000), ...every(1000 / 60, 6000, END_MS)];
  const s = summarize(replay(robot, times));
  console.log(`  ${s.ticks} ticks, ${robot.dropped} dropped; tilt max ${s.maxTiltDeg.toFixed(2)} deg`);
  assert.ok(robot.dropped >= 38 && robot.dropped <= 41, `${robot.dropped} dropped`);
  assert.ok(s.maxTiltDeg < 3 && s.minHeight > 0.74);
});

test('real gesture model recording: the robot falls when free, and follows when its pelvis is held', async (t) => {
  let real;
  try { real = JSON.parse(await fs.readFile(path.join(FIXTURES, 'miburi_reference.json'), 'utf8')); }
  catch { return t.skip('no miburi_reference.json'); }
  const { mujoco, model } = await loadAll();
  const frames = toFrames(real.body);
  const times = every(1000 / 60, 0, (frames.length - 1) * FRAME_MS);

  // Free-standing: the model leans the chest forward and raises both forearms.  The
  // stand-in has no balance control, so the centre of mass leaves the feet and it tips over.
  const free = summarize(replay(new RobotLoop(mujoco, model), times, 200, frames));
  // Pelvis held in place, as on a gantry: the upper body can be judged on its own.
  const held = summarize(replay(new RobotLoop(mujoco, model, { holdPelvis: true }), times, 200, frames));
  console.log(`  free: tilt max ${free.maxTiltDeg.toFixed(0)} deg, lowest pelvis ${free.minHeight.toFixed(2)} m`);
  console.log(`  held: ${held.ticks} ticks; retargeting error ${held.retargetErrDeg.toFixed(2)} deg; arm tracking `
    + `${held.armRmsDeg.toFixed(2)} deg RMS; motor at torque limit in ${held.saturatedPct.toFixed(1)}% of ticks; `
    + `limiter changed ${held.limitedPct.toFixed(1)}% of ticks after easing in, and held back up to `
    + `${held.engagingDeg.toFixed(0)} deg while easing in`);
  assert.ok(free.maxTiltDeg > 45, 'expected the free-standing stand-in to fall on this recording');
  assert.ok(held.maxTiltDeg < 0.5 && held.minHeight > 0.78);
  assert.ok(held.armRmsDeg < 1, `arm tracking ${held.armRmsDeg} degrees RMS`);
  // In this recording the arms hang nearly straight for 18 of 20 seconds, where the solver
  // keeps the human's upper arm twist and accepts a few degrees of bone direction error.
  assert.ok(held.retargetErrDeg < 3, `retargeting error ${held.retargetErrDeg} degrees`);
  assert.ok(held.saturatedPct < 2, `motor at its torque limit in ${held.saturatedPct}% of ticks`);
  // The recording opens with arms straight out and jumps to a real pose: the limiter absorbs that...
  assert.ok(held.engagingDeg > 30, `only ${held.engagingDeg} degrees held back at the start`);
  // ...and afterwards leaves the model's gestures alone.
  assert.ok(held.limitedPct < 1 && held.limitedDeg < 0.5, `limiter changed ${held.limitedPct}% of ticks by up to ${held.limitedDeg} degrees`);
});
