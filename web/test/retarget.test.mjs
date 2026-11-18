// The retargeting solver exists in Python and in JavaScript.  This test replays
// poses that the Python version solved (the reference fixture in test/fixtures)
// and fails if the JavaScript version gives different joint angles.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { G1_ISAACLAB_TO_MUJOCO_DOF, G1_MUJOCO_TO_ISAACLAB_DOF } from '../src/robot/g1-model.js';
import { G1Retargeter } from '../src/robot/retarget.js';
import { decodeMotion } from '../src/wire.js';
import { FIXTURES, loadAll } from './helpers.mjs';

const TOLERANCE_RAD = 1e-4; // 0.006 degrees
const ref = JSON.parse(await fs.readFile(path.join(FIXTURES, 'retarget_reference.json'), 'utf8'));
// Decode through the same function the live client uses.
const pose = (bodyInts) => decodeMotion({ seq: 0, pts_ms: 0, dt_ms: 40, n: 1, body: bodyInts })[0].body;
const maxDiff = (a, b) => a.reduce((m, x, i) => Math.max(m, Math.abs(x - b[i])), 0);

test('same MuJoCo version as the Python reference', async () => {
  const { mujoco } = await loadAll();
  assert.equal(mujoco.mj_versionString(), ref.mujoco_version);
});

test('recorded stream: joint angles equal the Python solver, pose after pose', async () => {
  const { mujoco, model } = await loadAll();
  const rt = new G1Retargeter(mujoco, model);
  let worst = 0, worstErr = 0;
  ref.stream.body.forEach((body, i) => {
    const res = rt.solve(pose(body));
    worst = Math.max(worst, maxDiff(Array.from(res.qpos), ref.stream.qpos[i]));
    worstErr = Math.max(worstErr, Math.abs(res.errorsDeg.right_forearm - ref.stream.right_forearm_error_deg[i]));
  });
  rt.dispose();
  console.log(`  ${ref.stream.body.length} poses, largest joint difference ${worst.toExponential(2)} rad`);
  assert.ok(worst < TOLERANCE_RAD, `largest joint difference ${worst} rad`);
  assert.ok(worstErr < 0.01, `reported forearm error differs by ${worstErr} degrees`);
});

test('random large poses, each from the standing pose: equal to the Python solver', async () => {
  const { mujoco, model } = await loadAll();
  const rt = new G1Retargeter(mujoco, model);
  // Through the live decoder (32-bit floats), although Python read 64-bit ones.
  // The solver's answer must not depend on rounding in the seventh decimal of its
  // input, including on the poses where it runs out of steps before it settles.
  let worst = 0, unsettled = 0, countsDiffer = 0;
  ref.random.body.forEach((body, i) => {
    rt.reset();
    const res = rt.solve(pose(body));
    worst = Math.max(worst, maxDiff(Array.from(res.qpos), ref.random.qpos[i]));
    if (res.iterations !== ref.random.iterations[i]) countsDiffer++;
    if (!res.settled) unsettled++;
  });
  rt.dispose();
  console.log(`  ${ref.random.body.length} poses, largest joint difference ${worst.toExponential(2)} rad, `
    + `${unsettled} used all ${rt.maxIters} steps, ${countsDiffer} with a different step count`);
  assert.ok(worst < TOLERANCE_RAD, `largest joint difference ${worst} rad`);
  assert.equal(unsettled, ref.random.settled.filter((x) => !x).length);
});

test('real gesture model recording: joint angles equal the Python solver', async (t) => {
  let real;
  try { real = JSON.parse(await fs.readFile(path.join(FIXTURES, 'miburi_reference.json'), 'utf8')); }
  catch { return t.skip('no miburi_reference.json'); }
  const { mujoco, model } = await loadAll();
  const rt = new G1Retargeter(mujoco, model);
  let worst = 0, iterations = 0;
  real.body.forEach((body, i) => {
    const res = rt.solve(pose(body));
    worst = Math.max(worst, maxDiff(Array.from(res.qpos), real.qpos[i]));
    iterations += res.iterations;
  });
  rt.dispose();
  console.log(`  ${real.body.length} poses, largest joint difference ${worst.toExponential(2)} rad, `
    + `${(iterations / real.body.length).toFixed(1)} iterations per pose`);
  assert.ok(worst < TOLERANCE_RAD, `largest joint difference ${worst} rad`);
});

test('joint order tables are inverses of each other', () => {
  G1_ISAACLAB_TO_MUJOCO_DOF.forEach((isaac, mj) => assert.equal(G1_MUJOCO_TO_ISAACLAB_DOF[isaac], mj));
});
