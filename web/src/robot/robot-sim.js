// The simulated G1: MuJoCo physics, with the model's own position servos
// tracking the joint targets it is given.
//
// Port of a Python reference implementation (not in this repository).  Like it, this is
// a stand-in for a real whole-body controller: it balances nothing and learns
// nothing.  It takes the same input a SONIC version 1 message carries, 29 joint
// targets in IsaacLab order, 50 times per second.
//
// Within a control tick the servo's set point moves in a straight line from the
// previous target to the new one.  Handing a stiff servo the whole change at
// once made the motors report their torque limit on ordinary motion.

import { G1_ISAACLAB_TO_MUJOCO_DOF, modelIndex } from './g1-model.js';

export const CONTROL_HZ = 50;
export const TICK_MS = 1000 / CONTROL_HZ;

export class G1StandIn {
  /**
   * holdPelvis keeps the pelvis fixed in space, as if the robot hung from a gantry.
   * The stand-in has no balance control: without it, a posture that moves the centre
   * of mass off the feet (chest leaning forward, both forearms raised) tips it over.
   */
  constructor(mujoco, model, { holdPelvis = false } = {}) {
    this.mj = mujoco; this.m = model;
    this.holdPelvis = holdPelvis;
    this.d = new mujoco.MjData(model);
    const ix = (this.ix = modelIndex(mujoco, model));
    this.substeps = Math.round(1 / CONTROL_HZ / model.opt.timestep);
    this.qadr = ix.hingeQadr;
    // actuator index for each hinge joint, in MuJoCo joint order
    const byJoint = new Map();
    for (let a = 0; a < model.nu; a++) byJoint.set(model.actuator_trnid[2 * a], a);
    this.act = ix.hinges.map((j) => byJoint.get(j));
    this.torqueLimit = this.act.map((a) =>
      Math.max(Math.abs(model.actuator_forcerange[2 * a]), Math.abs(model.actuator_forcerange[2 * a + 1])));
    this.pelvis = ix.body('pelvis');
    this.n = this.act.length;
    this.target = new Float64Array(this.n);
    this.prevTarget = new Float64Array(this.n);   // where the servo's set point is now
    this.peak = new Float64Array(this.n);
    this.reset();
  }

  dispose() { this.d.delete(); }

  reset() {
    const { mj, m, d } = this;
    mj.mj_resetDataKeyframe(m, d, this.ix.key('stand'));
    const qpos = d.qpos, ctrl = d.ctrl;
    for (let i = 0; i < this.n; i++) { this.target[i] = qpos[this.qadr[i]]; ctrl[this.act[i]] = this.target[i]; }
    this.prevTarget.set(this.target);
    this.baseQpos = Float64Array.from(qpos.subarray(0, 7)); // where the pelvis is held
    mj.mj_forward(m, d);
  }

  /** New joint targets, 29 values in IsaacLab order (one frame of a SONIC version 1 message). */
  apply(jointPosIsaacLab) {
    for (let i = 0; i < this.n; i++) this.target[i] = jointPosIsaacLab[G1_ISAACLAB_TO_MUJOCO_DOF[i]];
  }

  /** Advance one control period: 20 ms of physics. */
  tick() {
    const { mj, m, d } = this;
    this.peak.fill(0);
    const ctrl = d.ctrl, prev = this.prevTarget, target = this.target;
    for (let s = 0; s < this.substeps; s++) {
      const part = (s + 1) / this.substeps;
      for (let i = 0; i < this.n; i++) ctrl[this.act[i]] = prev[i] + (target[i] - prev[i]) * part;
      mj.mj_step(m, d);
      if (this.holdPelvis) { d.qpos.set(this.baseQpos, 0); d.qvel.fill(0, 0, 6); }
      const f = d.actuator_force;
      for (let i = 0; i < this.n; i++) this.peak[i] = Math.max(this.peak[i], Math.abs(f[this.act[i]]));
    }
    prev.set(target);
    const qpos = d.qpos, xmat = d.xmat, xpos = d.xpos;
    const actual = Float64Array.from(this.qadr, (a) => qpos[a]);
    const saturated = Array.from(this.peak, (p, i) => p >= 0.98 * this.torqueLimit[i]);
    const upZ = xmat[9 * this.pelvis + 8]; // z component of the pelvis's up axis
    return {
      t: d.time,
      target: Float64Array.from(this.target),
      actual,
      torque: Float64Array.from(this.peak),
      saturated,
      pelvisHeight: xpos[3 * this.pelvis + 2],
      tiltDeg: (Math.acos(Math.min(1, Math.max(-1, upZ))) * 180) / Math.PI,
    };
  }
}
