// The G1's adapter for the kinesics realizer (kinesics-realizer.js).  The G1 has no neck and no eyes, so
// what a person's head and eyes show has to go to other joints.  Which joints, and how much, is not
// decided here: it is a mapping the client picks (mappings.json, kinesics/mapping.js), for example the
// look away as a waist turn to the side ('side') or as a forward bend ('forward').
//
// Each target joint is its rest angle plus the mapping's sum for it.  Rest is the stand pose with the
// arms of robot/turn-poses.json.
//
// It has the interface the robot loop expects of a cue source: target(t), observe(actual, t), reset().

import { KinesicsRealizer } from './kinesics-realizer.js';
import { applyMapping, sources } from './mapping.js';
import POSES from '../robot/turn-poses.json' with { type: 'json' };

const RAD = Math.PI / 180;

export class G1Kinesics {
  /** mapping: one entry of mappings.json's g1 section, from pickMapping(). */
  constructor(mujoco, model, ix, standJoints, profiles, mapping, { setting = 'video_call', side = 1, seed = 1 } = {}) {
    const index = (name) => {
      const h = ix.hinges.indexOf(mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT.value, name));
      if (h < 0) throw new Error(`the G1 model has no joint ${name}`);
      return h;
    };
    this.mapping = mapping;
    this.realizer = new KinesicsRealizer(profiles, { setting, side, seed, headReturnsWithEyes: !!mapping.head_returns_with_eyes });
    this.rest = Float64Array.from(standJoints);
    for (const [n, v] of Object.entries(POSES.rest)) this.rest[index(n)] = v;
    this.targets = Object.keys(mapping.targets).map((n) => [n, index(n)]);
    this.q = new Float64Array(this.rest.length);
    this.last = {};
  }
  reset() { this.realizer.reset(); }
  plan(tracker, now, extraMs) { this.realizer.plan(tracker, now, extraMs); }
  /** Joint targets for local time t, MuJoCo hinge order. */
  target(t) {
    applyMapping(this.mapping, sources(this.realizer.sample(t)), this.last);   // degrees from rest, by joint name
    this.q.set(this.rest);
    for (const [name, i] of this.targets) this.q[i] += this.last[name] * RAD;
    return this.q;
  }
  observe() {}
  take() { return this.realizer.take(); }
}
