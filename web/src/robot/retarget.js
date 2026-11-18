// Kinematic retargeting: a human pose (joint rotations) -> Unitree G1 joint angles.
//
// This is a line-for-line port of a Python reference implementation (not in this repository).  The two
// must stay in step: test/retarget.test.mjs replays poses solved by the Python
// version and fails if this one disagrees.  Read the Python file for the full
// explanation; in short, it matches
//
//   * the orientation of the chest relative to the pelvis  -> 3 waist joints
//   * the direction of each upper arm (where the elbow is)  -> shoulder
//   * the direction of each forearm (where the wrist is)    -> shoulder twist and elbow
//   * the orientation of each hand                          -> 3 wrist joints
//
// The upper arm's twist about its own bone is left almost free (weight wTwist),
// because a human elbow is not a pure hinge and the G1's is.  The weight grows as
// the arm straightens (wTwistStraight): there, chasing the forearm's direction
// would spin the upper arm about itself.
//
// The joint angles come from damped least-squares inverse kinematics:
//   dq = (J^T J + lambda I)^-1 J^T e,  repeated from the previous solution.
// A step is kept only if it lowers the squared error; otherwise lambda is raised
// and the step retried.  A joint resting on its limit and pushed further out is
// held for that step.
//
// Matrices are 3x3, stored as flat arrays of 9 numbers in row order.

import { modelIndex } from './g1-model.js';

// fmt: SMPL-X body joint order, same as wire.py
export const BODY_JOINT_NAMES = [
  'pelvis', 'left_hip', 'right_hip', 'spine1', 'left_knee', 'right_knee',
  'spine2', 'left_ankle', 'right_ankle', 'spine3', 'left_foot', 'right_foot',
  'neck', 'left_collar', 'right_collar', 'head', 'left_shoulder',
  'right_shoulder', 'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist',
];
export const BODY_PARENTS = [-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19];
const B = Object.fromEntries(BODY_JOINT_NAMES.map((n, i) => [n, i]));

const ARM_JOINTS = ['shoulder_pitch', 'shoulder_roll', 'shoulder_yaw', 'elbow', 'wrist_roll', 'wrist_pitch', 'wrist_yaw'];
const WAIST_JOINTS = ['waist_yaw_joint', 'waist_roll_joint', 'waist_pitch_joint'];
const SIDES = [['left', 1], ['right', -1]];

const STEP_TOL = 1e-4;    // radians: a step smaller than this on every joint ends the solve
const LIMIT_TOL = 1e-9;   // radians: a joint this close to its range limit counts as resting on it
const LAMBDA_UP = 5.0;    // damping multiplier after a rejected step
const LAMBDA_DOWN = 0.3;  // damping multiplier after an accepted step, never below the starting value

// ---------------------------------------------------------------- 3x3 helpers
const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
function mul(a, b) {
  const o = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    o[3 * i + j] = a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j];
  }
  return o;
}
const tr = (a) => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
const mulVec = (a, v) => [
  a[0] * v[0] + a[1] * v[1] + a[2] * v[2],
  a[3] * v[0] + a[4] * v[1] + a[5] * v[2],
  a[6] * v[0] + a[7] * v[1] + a[8] * v[2],
];

/** SMPL axes (x left, y up, z forward) -> robot axes (x forward, y left, z up): C R C^T. */
const P = [2, 0, 1];
function toRobotAxes(R) {
  const o = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[3 * i + j] = R[3 * P[i] + P[j]];
  return o;
}

function quatToMat(q, o) {
  let x = q[o], y = q[o + 1], z = q[o + 2], w = q[o + 3];
  const n = Math.hypot(x, y, z, w) || 1; // undo int16 rounding on the wire
  x /= n; y /= n; z /= n; w /= n;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

function rot(axis, deg) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  if (axis === 'x') return [1, 0, 0, 0, c, -s, 0, s, c];
  if (axis === 'y') return [c, 0, s, 0, 1, 0, -s, 0, c];
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/** Rotation matrix -> rotation vector (axis * angle). */
export function logSO3(R) {
  const cos = Math.min(1, Math.max(-1, (R[0] + R[4] + R[8] - 1) / 2));
  const angle = Math.acos(cos);
  const v = [R[7] - R[5], R[2] - R[6], R[3] - R[1]];
  if (angle < 1e-6) return [0.5 * v[0], 0.5 * v[1], 0.5 * v[2]];
  if (Math.PI - angle < 1e-4) { // near 180 degrees: take the axis from the diagonal
    const any = Math.abs(v[0]) > 1e-9 || Math.abs(v[1]) > 1e-9 || Math.abs(v[2]) > 1e-9;
    return [0, 1, 2].map((i) => {
      const a = Math.sqrt(Math.max((R[4 * i] + 1) / 2, 0));
      return a * (any ? Math.sign(v[i] + 1e-12) : 1) * angle;
    });
  }
  const k = angle / (2 * Math.sin(angle));
  return [v[0] * k, v[1] * k, v[2] * k];
}

/** 22 local rotations (flat xyzw) -> 22 rotations relative to the pelvis, in robot axes. */
export function humanGlobalRotations(quats) {
  const g = new Array(22);
  g[0] = I3;
  for (let i = 1; i < 22; i++) g[i] = mul(g[BODY_PARENTS[i]], quatToMat(quats, 4 * i));
  return g.map(toRobotAxes);
}

/** Solve A x = b for a symmetric positive-definite A (n x n, flat), by Cholesky. */
function solveSPD(A, b, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      L[i * n + j] = i === j ? Math.sqrt(s) : s / L[j * n + j];
    }
  }
  const y = new Float64Array(n), x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
    y[i] = s / L[i * n + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  return x;
}

// ---------------------------------------------------------------- retargeter
/** Stateful: call solve() once per pose, in time order. */
export class G1Retargeter {
  constructor(mujoco, model, { damping = 0.05, maxIters = 30, wTorso = 1, wUpper = 1, wFore = 1, wHand = 0.3, wTwist = 0.1, wTwistStraight = 0.3, straightPower = 4 } = {}) {
    this.mj = mujoco; this.m = model;
    this.d = new mujoco.MjData(model);
    this.damping = damping; this.maxIters = maxIters;
    this.w = { torso: wTorso, upper: wUpper, fore: wFore, hand: wHand, twist: wTwist, twistStraight: wTwistStraight };
    this.straightPower = straightPower;
    const ix = (this.ix = modelIndex(mujoco, model));
    this.qStand = ix.standQpos;

    const names = [...WAIST_JOINTS];
    for (const [side] of SIDES) for (const j of ARM_JOINTS) names.push(`${side}_${j}_joint`);
    const jids = names.map(ix.joint);
    this.n = jids.length;                                   // 17 joints are solved for
    this.ikQadr = jids.map((j) => model.jnt_qposadr[j]);
    this.ikDadr = jids.map((j) => model.jnt_dofadr[j]);
    this.lo = jids.map((j) => model.jnt_range[2 * j]);
    this.hi = jids.map((j) => model.jnt_range[2 * j + 1]);

    this.torso = ix.body('torso_link');
    this.arms = SIDES.map(([side, sign]) => ({
      side, sign,
      upper: ix.body(`${side}_shoulder_yaw_link`),
      fore: ix.body(`${side}_elbow_link`),
      hand: ix.body(`${side}_wrist_yaw_link`),
      hShoulder: B[`${side}_shoulder`], hElbow: B[`${side}_elbow`], hWrist: B[`${side}_wrist`],
      elbowQadr: model.jnt_qposadr[ix.joint(`${side}_elbow_joint`)],
    }));
    this.jac = new mujoco.DoubleBuffer(3 * model.nv);        // rotational Jacobian, 3 x nv
    this.nRows = 3 + this.arms.length * 12;

    // --- calibration at qpos = 0 (upper arms down, forearms forward) ---
    const q0 = new Float64Array(model.nq);
    q0.set(this.qStand.subarray(0, 7));
    this.d.qpos.set(q0);
    mujoco.mj_kinematics(model, this.d);
    this.T_torso = this._R(this.torso);
    for (const a of this.arms) {
      const s = a.sign;
      const hUpper = rot('z', -90 * s);                      // human upper arm hanging down
      const hFore = mul(hUpper, rot('y', -90 * s));          // ... elbow flexed 90 degrees forward
      a.T_upper = mul(tr(toRobotAxes(hUpper)), this._R(a.upper));
      // The upper arm's bone direction in its own link frame: straight down at qpos = 0.
      a.b_upper = mulVec(tr(this._R(a.upper)), [0, 0, -1]);
      a.T_bone_dir = [0, s, 0];                              // C @ [s, 0, 0]: human arm bone in the T-pose
      // The forearm's direction in its own link frame: the axis that points forward
      // at qpos = 0 (see the Python file for why the wrist offset is not used).
      a.b_fore = mulVec(tr(this._R(a.fore)), [1, 0, 0]);
      a.T_hand = mul(tr(toRobotAxes(hFore)), this._R(a.hand));
    }
    this.reset();
  }

  dispose() { this.jac.delete(); this.d.delete(); }
  reset() { this.q = Float64Array.from(this.qStand); }

  _R(body) { const x = this.d.xmat; return Array.from(x.subarray(9 * body, 9 * body + 9)); }

  _targets(quats) {
    const g = humanGlobalRotations(quats);
    return {
      torso: mul(g[B.spine3], this.T_torso),
      arms: this.arms.map((a) => ({
        upper: mul(g[a.hShoulder], a.T_upper),
        upperDir: mulVec(g[a.hShoulder], a.T_bone_dir),
        fore: mulVec(g[a.hElbow], a.T_bone_dir),
        hand: mul(g[a.hWrist], a.T_hand),
      })),
    };
  }

  /** Fill the stacked error vector E (nRows) and Jacobian J (nRows x n) for the current pose. */
  _rows(targets, E, J) {
    const { mj, m, d, n, ikDadr } = this, nv = m.nv;
    let row = 0;
    const bodyRot = (b) => {
      mj.mj_jacBody(m, d, null, this.jac, b);
      const full = this.jac.GetView();
      const Jr = new Float64Array(3 * n);
      for (let r = 0; r < 3; r++) for (let c = 0; c < n; c++) Jr[r * n + c] = full[r * nv + ikDadr[c]];
      return [this._R(b), Jr];
    };
    const put = (w, e, Jr) => {
      for (let r = 0; r < 3; r++) {
        E[row + r] = w * e[r];
        for (let c = 0; c < n; c++) J[(row + r) * n + c] = w * Jr[r * n + c];
      }
      row += 3;
    };
    const orient = (w, target, b) => { const [R, Jr] = bodyRot(b); put(w, logSO3(mul(target, tr(R))), Jr); };

    // A bone's direction: the error is a difference of unit vectors, and
    // d(direction)/dq = -skew(direction) @ Jr.
    const direction = (w, target, b, bone) => {
      const [R, Jr] = bodyRot(b);
      const v = mulVec(R, bone);
      const S = [0, v[2], -v[1], -v[2], 0, v[0], v[1], -v[0], 0];
      const Jd = new Float64Array(3 * n);
      for (let r = 0; r < 3; r++) for (let c = 0; c < n; c++) {
        Jd[r * n + c] = S[3 * r] * Jr[c] + S[3 * r + 1] * Jr[n + c] + S[3 * r + 2] * Jr[2 * n + c];
      }
      put(w, [target[0] - v[0], target[1] - v[1], target[2] - v[2]], Jd);
    };

    orient(this.w.torso, targets.torso, this.torso);
    this.arms.forEach((a, i) => {
      const tg = targets.arms[i];
      direction(this.w.upper, tg.upperDir, a.upper, a.b_upper);
      orient(this._twistWeight(d.qpos[a.elbowQadr]), tg.upper, a.upper);
      direction(this.w.fore, tg.fore, a.fore, a.b_fore);
      orient(this.w.hand, tg.hand, a.hand);
    });
  }

  /** The G1's elbow joint reads 0 at a right angle and 90 degrees with the arm straight. */
  _twistWeight(qElbow) {
    const straight = Math.sin(qElbow) ** 2;   // 1 with the arm straight, 0 at a right angle
    return Math.sqrt(this.w.twist ** 2 + this.w.twistStraight ** 2 * straight ** this.straightPower);
  }

  /** Fill E and J for the joint angles q; returns the squared error. */
  _evaluate(q, targets, E, J) {
    const { mj, m, d } = this;
    d.qpos.set(q);
    mj.mj_kinematics(m, d);
    mj.mj_comPos(m, d);
    this._rows(targets, E, J);
    let cost = 0;
    for (let r = 0; r < this.nRows; r++) cost += E[r] * E[r];
    return cost;
  }

  /**
   * @param quats  22 local joint rotations as a flat xyzw array (88 numbers)
   * @returns { qpos: Float64Array(29) in MuJoCo joint order, iterations, settled, atLimit, errorsDeg }
   */
  solve(quats) {
    const { mj, m, d, n, nRows, ikQadr } = this;
    const targets = this._targets(quats);
    let E = new Float64Array(nRows), J = new Float64Array(nRows * n);
    let E2 = new Float64Array(nRows), J2 = new Float64Array(nRows * n);
    const A = new Float64Array(n * n), g = new Float64Array(n);
    const lamMin = this.damping * this.damping;
    let lam = lamMin;
    let cost = this._evaluate(this.q, targets, E, J);
    let it = 0, settled = false;
    for (it = 1; it <= this.maxIters; it++) {
      for (let i = 0; i < n; i++) {
        let gi = 0;
        for (let r = 0; r < nRows; r++) gi += J[r * n + i] * E[r];
        g[i] = gi;
        for (let j = 0; j <= i; j++) {
          let s = 0;
          for (let r = 0; r < nRows; r++) s += J[r * n + i] * J[r * n + j];
          A[i * n + j] = A[j * n + i] = s + (i === j ? lam : 0);
        }
      }
      // A joint resting on its limit, whose error pulls it further out, cannot move.
      // Hold it for this step so the others are solved for knowing that.
      for (let i = 0; i < n; i++) {
        const qi = this.q[ikQadr[i]];
        if ((qi <= this.lo[i] + LIMIT_TOL && g[i] < 0) || (qi >= this.hi[i] - LIMIT_TOL && g[i] > 0)) {
          for (let k = 0; k < n; k++) { A[i * n + k] = 0; A[k * n + i] = 0; }
          A[i * n + i] = 1; g[i] = 0;
        }
      }
      const dq = solveSPD(A, g, n);
      const qTry = Float64Array.from(this.q);
      let step = 0;
      for (let i = 0; i < n; i++) {
        if (!Number.isFinite(dq[i])) throw new Error('inverse kinematics step is not finite');
        const a = ikQadr[i];
        qTry[a] = Math.min(this.hi[i], Math.max(this.lo[i], this.q[a] + dq[i]));
        step = Math.max(step, Math.abs(qTry[a] - this.q[a]));
      }
      if (step < STEP_TOL) { settled = true; break; }   // nothing left to move: settled
      const costTry = this._evaluate(qTry, targets, E2, J2);
      if (costTry < cost) {                              // keep the step, trust the model a little more
        this.q = qTry; cost = costTry;
        [E, E2] = [E2, E]; [J, J2] = [J2, J];
        lam = Math.max(lam * LAMBDA_DOWN, lamMin);
      } else {                                           // reject it, take a shorter and more cautious one
        lam *= LAMBDA_UP;
      }
    }
    it = Math.min(it, this.maxIters);
    d.qpos.set(this.q);
    mj.mj_kinematics(m, d);
    const { hingeQadr, hingeRange } = this.ix;
    const qpos = Float64Array.from(hingeQadr, (a) => this.q[a]);
    const tol = 1e-3;
    const atLimit = hingeRange.map(([lo, hi], i) => qpos[i] <= lo + tol || qpos[i] >= hi - tol);
    return { qpos, iterations: it, settled, atLimit, errorsDeg: this._poseErrors(targets) };
  }

  /**
   * Angle, in degrees, between what was asked for and what the robot's links do.
   * upper and forearm are bone directions; torso and hand are full orientations;
   * twist is the upper arm's full orientation, which the solver barely tries to match.
   */
  _poseErrors(targets) {
    const deg = 180 / Math.PI;
    const ang = (Rt, Rr) => Math.hypot(...logSO3(mul(Rt, tr(Rr)))) * deg;
    const between = (u, v) => Math.acos(Math.min(1, Math.max(-1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]))) * deg;
    const out = { torso: ang(targets.torso, this._R(this.torso)) };
    this.arms.forEach((a, i) => {
      const tg = targets.arms[i];
      out[`${a.side}_upper`] = between(mulVec(this._R(a.upper), a.b_upper), tg.upperDir);
      out[`${a.side}_forearm`] = between(mulVec(this._R(a.fore), a.b_fore), tg.fore);
      out[`${a.side}_twist`] = ang(tg.upper, this._R(a.upper));
      out[`${a.side}_hand`] = ang(tg.hand, this._R(a.hand));
    });
    return out;
  }
}
