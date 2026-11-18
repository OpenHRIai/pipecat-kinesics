// Reference limiter: the last thing the joint targets pass through before the controller.
//
// Port of a Python reference implementation (not in this repository).
// test/limiter.test.mjs replays an input the Python version limited and fails if
// this one answers differently.
//
// Whatever comes in, what goes out stays inside each joint's range, under its
// speed limit and under its acceleration limit.  A motion that already does so
// passes through unchanged, exactly, with no delay.  For the first ENGAGE_S
// seconds after reset() or engage() the speed limit rises from zero, so the
// robot eases into a stream instead of lunging at its first pose.
//
// The limits are starting values, not measurements of the G1.

export const CONTROL_DT = 1 / 50;

// MuJoCo joint order: 0 to 11 legs, 12 to 14 waist, 15 to 28 arms.
const N_JOINTS = 29, ARM_START = 15;
export const SPEED_LIMIT = { body: 3.0, arm: 8.0 };       // radians per second
export const ACCEL_LIMIT = { body: 40.0, arm: 200.0 };    // radians per second squared
export const ENGAGE_S = 1.0;

/** { vMax, aMax } for the 29 joints, MuJoCo order. */
export function defaultLimits() {
  const vMax = new Float64Array(N_JOINTS).fill(SPEED_LIMIT.body);
  const aMax = new Float64Array(N_JOINTS).fill(ACCEL_LIMIT.body);
  vMax.fill(SPEED_LIMIT.arm, ARM_START); aMax.fill(ACCEL_LIMIT.arm, ARM_START);
  return { vMax, aMax };
}

const clip = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

/** Stateful: call reset() with the robot's current joint angles, then step() once per control tick. */
export class JointLimiter {
  constructor(lo, hi, { vMax, aMax, dt = CONTROL_DT, engageS = ENGAGE_S } = {}) {
    this.n = lo.length;
    this.lo = Float64Array.from(lo); this.hi = Float64Array.from(hi);
    const d = defaultLimits();
    this.vMax = Float64Array.from(vMax ?? d.vMax); this.aMax = Float64Array.from(aMax ?? d.aMax);
    this.dt = dt;
    this.engageTicks = Math.round(engageS / dt);
    this.reset(new Float64Array(this.n));
  }

  /** Start from the joint angles q (where the robot is now), at rest. */
  reset(q) {
    this.q = Float64Array.from(q, (x, i) => clip(x, this.lo[i], this.hi[i]));
    this.v = new Float64Array(this.n);
    this.r = Float64Array.from(this.q);   // the previous input, after the range limit
    this.engage();
  }

  /** Ease in again from the current speed limit of zero, without moving. */
  engage() { this.ticks = 0; }

  /** @returns { q, v, limited: boolean per joint, anyLimited, engaging } */
  step(target) {
    const { n, dt } = this;
    this.ticks += 1;
    const engaging = this.ticks <= this.engageTicks;
    const scale = this.engageTicks ? Math.min(1.0, this.ticks / this.engageTicks) : 1.0;
    const q = new Float64Array(n), v = new Float64Array(n), limited = new Array(n);
    let anyLimited = false;
    for (let i = 0; i < n; i++) {
      const a = this.aMax[i], vMax = this.vMax[i] * scale;
      const r = clip(target[i], this.lo[i], this.hi[i]);
      const vt = (r - this.r[i]) / dt;              // how fast the input itself is moving
      const e = this.r[i] - this.q[i];              // how far behind the input we were
      const d = Math.abs(e);
      // How fast to close the gap: all of it now if one tick of braking can shed that
      // speed afterwards, otherwise the fastest speed that can still stop in the distance left.
      const full = d / dt;
      const h = 1.5 * a * dt;
      const brake = Math.sqrt(2.0 * a * d + h * h) - h;
      const closing = full <= a * dt ? full : Math.min(full, brake);
      const want = vt + Math.sign(e) * closing;
      let vi = clip(want, -vMax, vMax);
      vi = clip(vi, this.v[i] - a * dt, this.v[i] + a * dt);
      // Nothing was limited: land on the input exactly, so no rounding error builds up.
      const untouched = vi === want && closing === full;
      const qi = clip(untouched ? r : this.q[i] + vi * dt, this.lo[i], this.hi[i]);
      v[i] = (qi - this.q[i]) / dt;
      q[i] = qi;
      limited[i] = !untouched || r !== target[i];
      anyLimited ||= limited[i];
      this.r[i] = r;
    }
    this.q = q; this.v = v;
    return { q, v, limited, anyLimited, engaging };
  }
}
