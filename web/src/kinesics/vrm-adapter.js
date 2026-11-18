// The avatar's adapter for the kinesics realizer (kinesics-realizer.js): applies a client-side mapping
// (mappings.json, kinesics/mapping.js) to a VRM model.  The mapping says which bone shows what: its
// targets are "bone.axis" of the model's normalized humanoid bones, in degrees, plus eyes.yaw,
// eyes.pitch and blink.
//
// Axes of a VRM model's normalized bones, at rest: the model faces +Z, up is +Y, and +X is its left.
// A turn to the model's left is a positive rotation about y; chin up is a negative rotation about x.
// Models in the older VRM 0 format face -Z and are turned half a circle about y when loaded
// (avatar.js), which reverses their bones' x and z axes: the adapter negates those two, so a mapping
// is written once, in the axes above, for both formats.
//
// The mouth has two parts.  Its resting posture is a turn cue and comes from the mapping (target
// "mouth": opening before the first sound, half open in a pause, closed at the end).  The lip movement
// on top of it is a placeholder, opened by the loudness of the bot's audio.  The larger of the two shows.

import { applyMapping, sources } from './mapping.js';

const RAD = Math.PI / 180;

export class VrmKinesics {
  /** vrm: a loaded three-vrm model.  mapping: one entry of mappings.json's vrm section, from pickMapping(). */
  constructor(vrm, mapping) {
    this.vrm = vrm; this.mapping = mapping;
    this.flip = vrm.meta?.metaVersion === '0' ? -1 : 1;   // VRM 0: x and z reversed
    this.bones = new Map();
    for (const target of Object.keys(mapping.targets)) {
      const [bone, axis] = target.split('.');
      if (!axis || bone === 'eyes') continue;
      if (!this.bones.has(bone)) this.bones.set(bone, vrm.humanoid.getNormalizedBoneNode(bone));
    }
    if (vrm.lookAt) { vrm.lookAt.autoUpdate = false; vrm.lookAt.target = null; }
    this.last = {};
  }

  /** mouth: the lip movement, 0 (closed) to 1, or null for none. */
  apply(s, mouth = null) {
    const a = applyMapping(this.mapping, sources(s), this.last);
    for (const [bone, node] of this.bones) {
      if (node) node.rotation.set(this.flip * (a[`${bone}.x`] ?? 0) * RAD, (a[`${bone}.y`] ?? 0) * RAD, this.flip * (a[`${bone}.z`] ?? 0) * RAD, 'ZXY');
    }
    const { lookAt, expressionManager: em } = this.vrm;
    if (lookAt) { lookAt.yaw = a['eyes.yaw'] ?? 0; lookAt.pitch = a['eyes.pitch'] ?? 0; }
    if (em) { em.setValue('blink', a.blink ?? 0); if (mouth !== null || 'mouth' in a) em.setValue('aa', Math.min(1, Math.max(a.mouth ?? 0, mouth ?? 0))); }
  }
}
