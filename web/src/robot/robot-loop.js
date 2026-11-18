// The robot client's control loop, as it runs in a browser tab.
//
// On a robot this would be a thread that wakes exactly 50 times per second.  A
// browser offers no such thing: the page is called once per screen refresh,
// and less often when the tab is hidden.  So each time the page is called,
// this loop works out how many 20 ms control ticks have come due since last
// time and runs them all, one after another:
//
//   for each due tick:
//     1. read the human pose for that moment from the pose buffer
//     2. retarget it to G1 joint angles
//        (or, with no pose for that moment, ask the turn cue realizer where the joints should be,
//        when one is attached: src/robot/turn-realizer.js)
//     3. pass them through the reference limiter (range, speed, acceleration)
//     4. hand the 29 joint targets to the simulated robot
//     5. advance the physics by 20 ms
//
// "That moment" is a position on the agent's audio timeline, the same clock
// the avatar reads, so both bodies move with the speech.

import { MotionRing } from '../motion-ring.js';
import { G1_MUJOCO_TO_ISAACLAB_DOF } from './g1-model.js';
import { JointLimiter } from './limiter.js';
import { G1Retargeter } from './retarget.js';
import { CONTROL_HZ, G1StandIn, TICK_MS } from './robot-sim.js';

const MAX_TICKS_PER_CALL = 10;  // after a stall longer than 200 ms, drop the backlog instead of replaying it
const WINDOW = 2 * CONTROL_HZ;   // statistics cover the last 2 seconds
const ARMS = [15, 29];           // MuJoCo joint order: 15 to 21 left arm, 22 to 28 right arm
const DEG = 180 / Math.PI;
const REENGAGE_TICKS = CONTROL_HZ; // a stream that resumes after 1 second without poses is eased into again

export class RobotLoop {
  constructor(mujoco, model, { holdPelvis = false } = {}) {
    this.retargeter = new G1Retargeter(mujoco, model);
    this.sim = new G1StandIn(mujoco, model, { holdPelvis });
    this.ring = new MotionRing();
    this.isaac = new Float64Array(29);
    const { hingeRange, hingeQadr } = this.retargeter.ix;
    this.standJoints = Float64Array.from(hingeQadr, (a) => this.retargeter.qStand[a]);
    this.limiter = new JointLimiter(hingeRange.map((r) => r[0]), hingeRange.map((r) => r[1]));
    this.limiter.reset(this.standJoints);
    this.wanted = null;         // the newest retargeted joint angles, before the limiter
    this.cues = null;           // a TurnRealizer, when the bot sends turn cues instead of poses
    this.sincePose = 0;         // control ticks since a pose was last available
    this.resetClock();
    this.log = [];              // one record per tick, newest last, at most WINDOW long
    this.ticks = 0; this.dropped = 0; this.posed = 0; this.cued = 0;
  }

  /** A decoded pose frame from the stream (the same object the avatar's buffer gets). */
  push(frame, playheadAtArrival) { this.ring.push(frame, playheadAtArrival); }

  resetClock() { this.lastMs = null; this.carryMs = 0; }

  /** Put the robot back on its feet and forget the stream. */
  reset() {
    this.sim.reset(); this.retargeter.reset(); this.ring.clear(); this.resetClock(); this.log.length = 0;
    this.limiter.reset(this.standJoints); this.wanted = null; this.sincePose = 0;
    this.cues?.reset();
  }

  /**
   * Run every control tick that has come due.
   * @param nowMs  performance.now()
   * @param playheadMs  current position on the agent's audio timeline, or NaN when there is no stream
   */
  advance(nowMs, playheadMs) {
    if (this.lastMs === null) { this.lastMs = nowMs; return 0; }
    this.carryMs += nowMs - this.lastMs; this.lastMs = nowMs;
    let due = Math.floor(this.carryMs / TICK_MS);
    this.carryMs -= due * TICK_MS;
    if (due > MAX_TICKS_PER_CALL) { this.dropped += due - MAX_TICKS_PER_CALL; due = MAX_TICKS_PER_CALL; }

    for (let k = 0; k < due; k++) {
      const t0 = performance.now();
      const rec = { retargetMs: 0, iterations: 0, retargetErrDeg: NaN, speaking: false, posed: false, cued: false,
        limited: false, engaging: false, limitedDeg: 0 };
      // The newest due tick is "now"; earlier ones in this batch are 20 ms apart behind it.
      const behind = (due - 1 - k) * TICK_MS, tickMs = nowMs - behind;
      const pts = playheadMs - behind;
      const sample = Number.isFinite(pts) ? this.ring.sample(pts) : null;
      if (sample) {
        const r = this.retargeter.solve(sample.body);
        if (this.sincePose >= REENGAGE_TICKS) this.limiter.engage();
        this.wanted = r.qpos; this.sincePose = 0;
        rec.retargetMs = performance.now() - t0;
        rec.iterations = r.iterations;
        const e = r.errorsDeg;
        rec.retargetErrDeg = (e.left_upper + e.left_forearm + e.right_upper + e.right_forearm) / 4;
        rec.speaking = !!sample.speaking; rec.posed = true; this.posed++;
      } else {
        this.sincePose++;
        if (this.cues) { this.wanted = this.cues.target(tickMs); rec.cued = true; this.cued++; }
      }
      // Without a new pose the last one stands, and the limiter keeps closing in on it.
      if (this.wanted) {
        const lim = this.limiter.step(this.wanted);
        for (let i = 0; i < 29; i++) {
          const j = G1_MUJOCO_TO_ISAACLAB_DOF[i];
          this.isaac[i] = lim.q[j];
          rec.limitedDeg = Math.max(rec.limitedDeg, Math.abs(lim.q[j] - this.wanted[j]) * DEG);
        }
        this.sim.apply(this.isaac);
        rec.limited = lim.anyLimited; rec.engaging = lim.engaging;
      }
      const s = this.sim.tick();
      if (rec.cued) this.cues.observe(s.actual, tickMs);
      let sq = 0;
      for (let i = ARMS[0]; i < ARMS[1]; i++) sq += (s.actual[i] - s.target[i]) ** 2;
      rec.armErrSq = sq / (ARMS[1] - ARMS[0]);
      rec.saturated = s.saturated.some(Boolean);
      rec.tiltDeg = s.tiltDeg; rec.pelvisHeight = s.pelvisHeight;
      rec.tickMs = performance.now() - t0;
      this.log.push(rec); if (this.log.length > WINDOW) this.log.shift();
      this.ticks++;
    }
    return due;
  }

  /** Averages over the last 2 seconds of ticks. */
  stats() {
    const L = this.log, n = L.length;
    if (!n) return null;
    const posed = L.filter((r) => r.posed), np = posed.length;
    const mean = (a, f) => (a.length ? a.reduce((s, r) => s + f(r), 0) / a.length : NaN);
    return {
      ticks: this.ticks, dropped: this.dropped, posedTicks: this.posed, cuedTicks: this.cued,
      tickMs: mean(L, (r) => r.tickMs), tickMsMax: Math.max(...L.map((r) => r.tickMs)),
      retargetMs: mean(posed, (r) => r.retargetMs),
      iterations: mean(posed, (r) => r.iterations),
      retargetErrDeg: mean(posed, (r) => r.retargetErrDeg),
      armRmsDeg: Math.sqrt(mean(L, (r) => r.armErrSq)) * DEG,
      saturatedPct: (100 * L.filter((r) => r.saturated).length) / n,
      limitedPct: (100 * L.filter((r) => r.limited && !r.engaging).length) / n,
      limitedDeg: Math.max(...L.map((r) => r.limitedDeg)),
      engaging: L[n - 1].engaging,
      tiltDeg: L[n - 1].tiltDeg, pelvisHeight: L[n - 1].pelvisHeight,
      posedPct: (100 * np) / n,
    };
  }
}
