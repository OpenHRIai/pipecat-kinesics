// Client-side mappings: what the realizer says, as G1 joints and avatar bones (src/kinesics/mappings.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyMapping, pickMapping, sources } from '../src/kinesics/mapping.js';

const read = (f) => JSON.parse(readFileSync(new URL(`../src/kinesics/${f}`, import.meta.url)));
const PROFILES = read('profiles.json'), MAPPINGS = read('mappings.json');
const S = PROFILES.profiles.video_call.speaking;
const s0 = { headYawDeg: 0, headPitchDeg: 0, eyeYawDeg: 0, handTl: 0, hand: 0, blink: 0, torsoLeanDeg: 0, liveYawDeg: 0, livePitchDeg: 0 };
const away = { ...s0, headYawDeg: S.head_away_deg + 1.5, liveYawDeg: 1.5, eyeYawDeg: S.eye_away_deg, headPitchDeg: -2.3, torsoLeanDeg: 0.7 };
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} against ${b}`);
const g1 = (name, s) => applyMapping(pickMapping(MAPPINGS, 'g1', name), sources(s));

test('G1, side: the look away is a waist turn of 40% of the head and eye angles; chin down is a lean forward', () => {
  const a = g1('side', away);
  near(a.waist_yaw_joint, 0.4 * (S.head_away_deg + S.eye_away_deg), 'waist turn');
  near(a.waist_pitch_joint, 2.3, 'waist lean: the human torso lean and the small continuous motion are not shown');
});

test('G1, side: a glance turns the waist back by the eyes\' part only', () => {
  near(g1('side', { ...away, eyeYawDeg: 0 }).waist_yaw_joint, 0.4 * S.head_away_deg, 'waist turn during a glance');
});

test('G1, forward: the same look away is a forward bend, to whichever side the body would have looked', () => {
  for (const side of [1, -1]) {
    const a = g1('forward', { ...away, headYawDeg: side * S.head_away_deg, liveYawDeg: 0, eyeYawDeg: side * S.eye_away_deg });
    assert.equal(a.waist_yaw_joint, undefined, 'no waist turn');
    near(a.waist_pitch_joint, 2.3 + 0.4 * (S.head_away_deg + S.eye_away_deg), 'waist bend');
  }
});

test('G1: the arm rises with the hand, and the default mapping is the forward one', () => {
  near(g1(null, { ...s0, hand: 0.5 }).right_elbow_joint, -31.5 / 2, 'elbow, half raised');
  assert.equal(pickMapping(MAPPINGS, 'g1').name, 'forward');
});

test('avatar: neck and head share each head angle; the small motion is a quarter of its size; arms hang', () => {
  const a = applyMapping(pickMapping(MAPPINGS, 'vrm'), sources({ ...s0, headYawDeg: 10 + 4, liveYawDeg: 4, headPitchDeg: -2, eyeYawDeg: 10, blink: 0.7, hand: 1 }));
  near(a['neck.y'] + a['head.y'], 10 + 0.25 * 4, 'head turn');
  near(a['neck.y'], 0.4 * 10 + 0.1 * 4, 'the neck\'s share');
  near(a['neck.x'] + a['head.x'], 2, 'chin down is a positive rotation about x');
  assert.equal(a['eyes.yaw'], 10); assert.equal(a.blink, 0.7);
  near(a['rightLowerArm.y'], 64, 'right elbow, hand raised'); near(a['leftUpperArm.z'], -72, 'left arm at rest');
});

test('a mapping that names a source that does not exist is refused', () => {
  assert.throws(() => applyMapping({ targets: { x: { nonsense: 1 } } }, sources(s0)), /unknown source/);
});

test('avatar: the resting mouth posture goes to the mouth at 80% size; the G1 has no mouth', () => {
  const v = applyMapping(pickMapping(MAPPINGS, 'vrm'), sources({ ...s0, mouth: 0.5 }));
  near(v.mouth, 0.4, 'mouth');
  for (const name of ['side', 'forward']) assert.ok(!('mouth' in pickMapping(MAPPINGS, 'g1', name).targets));
});
