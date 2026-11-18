// The reference limiter exists in Python and in JavaScript.  This test replays an
// input the Python version limited (the reference fixture in test/fixtures)
// and fails if the JavaScript version answers differently.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { ACCEL_LIMIT, JointLimiter, SPEED_LIMIT, defaultLimits } from '../src/robot/limiter.js';
import { FIXTURES } from './helpers.mjs';

const ref = JSON.parse(await fs.readFile(path.join(FIXTURES, 'limiter_reference.json'), 'utf8'));

test('smooth motion, jumps and out-of-range targets: equal to the Python limiter', () => {
  const lim = new JointLimiter(ref.lo, ref.hi, { vMax: ref.v_max, aMax: ref.a_max, dt: ref.dt, engageS: ref.engage_s });
  lim.reset(ref.start);
  let worstQ = 0, worstV = 0, flags = 0, limitedTicks = 0;
  ref.target.forEach((target, k) => {
    const s = lim.step(target);
    for (let i = 0; i < target.length; i++) {
      worstQ = Math.max(worstQ, Math.abs(s.q[i] - ref.q[k][i]));
      worstV = Math.max(worstV, Math.abs(s.v[i] - ref.v[k][i]));
      if (Number(s.limited[i]) !== ref.limited[k][i]) flags++;
    }
    assert.equal(Number(s.engaging), ref.engaging[k]);
    if (s.anyLimited) limitedTicks++;
  });
  console.log(`  ${ref.target.length} ticks of ${ref.lo.length} joints: largest difference ${worstQ.toExponential(1)} rad, `
    + `${worstV.toExponential(1)} rad/s; ${limitedTicks} ticks limited`);
  assert.ok(worstQ < 1e-12 && worstV < 1e-9, `differs by ${worstQ} rad, ${worstV} rad/s`);
  assert.equal(flags, 0, 'the two disagree on which joints were limited');
});

test('what comes out always respects range, speed and acceleration', () => {
  const lim = new JointLimiter(ref.lo, ref.hi, { vMax: ref.v_max, aMax: ref.a_max, dt: ref.dt, engageS: 0 });
  lim.reset(ref.start);
  let prevV = new Float64Array(ref.lo.length);
  for (const target of ref.target) {
    const s = lim.step(target);
    for (let i = 0; i < target.length; i++) {
      assert.ok(s.q[i] >= ref.lo[i] && s.q[i] <= ref.hi[i]);
      assert.ok(Math.abs(s.v[i]) <= ref.v_max[i] + 1e-9);
      assert.ok(Math.abs(s.v[i] - prevV[i]) / ref.dt <= ref.a_max[i] + 1e-6);
    }
    prevV = s.v;
  }
});

test('default limits: arms faster than waist and legs', () => {
  const { vMax, aMax } = defaultLimits();
  assert.equal(vMax.length, 29);
  assert.equal(vMax[14], SPEED_LIMIT.body); assert.equal(vMax[15], SPEED_LIMIT.arm);
  assert.equal(aMax[0], ACCEL_LIMIT.body); assert.equal(aMax[28], ACCEL_LIMIT.arm);
});
