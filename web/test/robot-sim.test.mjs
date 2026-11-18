// The simulated G1 in MuJoCo's WebAssembly build: it stands, and it follows a joint target.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { G1_MUJOCO_TO_ISAACLAB_DOF } from '../src/robot/g1-model.js';
import { CONTROL_HZ, G1StandIn } from '../src/robot/robot-sim.js';
import { loadAll } from './helpers.mjs';

const toIsaacLab = (mj) => G1_MUJOCO_TO_ISAACLAB_DOF.map((i) => mj[i]);

test('the model is the 29-joint G1 with a 2 ms physics step', async () => {
  const { model } = await loadAll();
  assert.equal(model.nu, 29);
  assert.equal(model.nq, 36);
  assert.equal(model.opt.timestep, 0.002);
});

test('holds the standing pose for 2 seconds', async () => {
  const { mujoco, model } = await loadAll();
  const robot = new G1StandIn(mujoco, model);
  assert.equal(robot.substeps, 10);
  let s;
  for (let i = 0; i < 2 * CONTROL_HZ; i++) s = robot.tick();
  assert.ok(Math.abs(s.t - 2) < 1e-9);
  assert.ok(s.pelvisHeight > 0.74 && s.pelvisHeight < 0.82, `pelvis height ${s.pelvisHeight} m`);
  assert.ok(s.tiltDeg < 3, `tilt ${s.tiltDeg} degrees`);
  robot.dispose();
});

test('follows a joint target given in IsaacLab order', async () => {
  const { mujoco, model } = await loadAll();
  const robot = new G1StandIn(mujoco, model);
  const target = Float64Array.from(robot.target);       // MuJoCo order
  const leftShoulderRoll = 16, rightElbow = 25;          // MuJoCo joint positions among the 29
  target[leftShoulderRoll] += 0.4; target[rightElbow] -= 0.5;
  robot.apply(toIsaacLab(target));
  let s;
  for (let i = 0; i < 1 * CONTROL_HZ; i++) s = robot.tick();
  assert.ok(Math.abs(s.actual[leftShoulderRoll] - target[leftShoulderRoll]) < 0.03);
  assert.ok(Math.abs(s.actual[rightElbow] - target[rightElbow]) < 0.03);
  assert.ok(s.tiltDeg < 5, `tilt ${s.tiltDeg} degrees`);
  robot.dispose();
});
