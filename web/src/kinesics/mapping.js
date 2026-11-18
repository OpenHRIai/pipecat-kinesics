// Client-side mapping from the kinesics realizer's output to a body's joints or bones (mappings.json).
// The realizer says what a body shows; a mapping says which joint shows it on this body, and how much.
// Changing where a cue goes (a waist turn, a forward bend, both) is a change to the table, not to code.

/** The named sources a mapping can draw on, from one sample of the realizer. Degrees, except hand, blink, mouth and const. */
export function sources(s) {
  const headSided = s.headYawDeg - s.liveYawDeg;
  return {
    head_away: Math.abs(headSided), eye_away: Math.abs(s.eyeYawDeg),
    head_away_sided: headSided, eye_away_sided: s.eyeYawDeg,
    head_pitch: s.headPitchDeg - s.livePitchDeg,
    live_yaw: s.liveYawDeg, live_pitch: s.livePitchDeg,
    torso_lean: s.torsoLeanDeg, hand: s.hand, blink: s.blink, mouth: s.mouth ?? 0, const: 1,
  };
}

/** target name -> the sum of gain x source over the mapping's line for it (degrees, or the source's own unit). */
export function applyMapping(mapping, src, out = {}) {
  for (const [target, line] of Object.entries(mapping.targets)) {
    let v = 0;
    for (const [name, gain] of Object.entries(line)) {
      if (!(name in src)) throw new Error(`kinesics mapping: unknown source '${name}' for ${target}`);
      v += gain * src[name];
    }
    out[target] = v;
  }
  return out;
}

/** The mapping called `name` for a body ('g1' or 'vrm'), or that body's default. */
export function pickMapping(mappings, body, name) {
  const all = mappings[body], key = name || all.default, m = all[key];
  if (!m || !m.targets) throw new Error(`kinesics: no ${body} mapping '${key}'`);
  return { name: key, ...m };
}
