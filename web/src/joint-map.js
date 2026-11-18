// SMPL-X -> VRM 1.0 humanoid bone map.
//
// Both rigs are Y-up, face +Z, and have a T-pose rest with arms along +-X, so
// local joint rotations transfer 1:1 as long as they are applied to three-vrm's
// *normalized* human bones (whose rest rotations are identity, like SMPL-X's).
// SMPL-X joints without a VRM counterpart are folded into their children (see
// avatar.js) or dropped (eyes, when the model has no eye bones).
//
// SMPL-X index : name            -> VRM bone
//   0  pelvis            -> hips           (rotation = SMPL-X global orientation)
//   1  left_hip          -> leftUpperLeg
//   2  right_hip         -> rightUpperLeg
//   3  spine1            -> spine
//   4  left_knee         -> leftLowerLeg
//   5  right_knee        -> rightLowerLeg
//   6  spine2            -> chest
//   7  left_ankle        -> leftFoot
//   8  right_ankle       -> rightFoot
//   9  spine3            -> upperChest     (optional in VRM; folded into neck/shoulders if absent)
//  10  left_foot         -> leftToes       (optional)
//  11  right_foot        -> rightToes      (optional)
//  12  neck              -> neck           (optional)
//  13  left_collar       -> leftShoulder   (optional)
//  14  right_collar      -> rightShoulder  (optional)
//  15  head              -> head
//  16  left_shoulder     -> leftUpperArm
//  17  right_shoulder    -> rightUpperArm
//  18  left_elbow        -> leftLowerArm
//  19  right_elbow       -> rightLowerArm
//  20  left_wrist        -> leftHand
//  21  right_wrist       -> rightHand
//  22  jaw               -> jaw (optional) else expression "aa" from the opening angle
//  23  left_eye_smplhf   -> leftEye (optional)
//  24  right_eye_smplhf  -> rightEye (optional)
//  25-27 left_index1..3  -> leftIndexProximal / Intermediate / Distal
//  28-30 left_middle1..3 -> leftMiddle*
//  31-33 left_pinky1..3  -> leftLittle*
//  34-36 left_ring1..3   -> leftRing*
//  37-39 left_thumb1..3  -> leftThumbMetacarpal / Proximal / Distal
//  40-54 right_*         -> mirror of the above
//
// SMPL-X expression coefficients (100 FLAME-style) have no VRM equivalent and
// are ignored except that the jaw drives "aa" when the model has no jaw bone.

export const SMPLX_JOINT_NAMES = [
  'pelvis', 'left_hip', 'right_hip', 'spine1', 'left_knee', 'right_knee',
  'spine2', 'left_ankle', 'right_ankle', 'spine3', 'left_foot', 'right_foot',
  'neck', 'left_collar', 'right_collar', 'head', 'left_shoulder',
  'right_shoulder', 'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist',
  'jaw', 'left_eye_smplhf', 'right_eye_smplhf',
  'left_index1', 'left_index2', 'left_index3',
  'left_middle1', 'left_middle2', 'left_middle3',
  'left_pinky1', 'left_pinky2', 'left_pinky3',
  'left_ring1', 'left_ring2', 'left_ring3',
  'left_thumb1', 'left_thumb2', 'left_thumb3',
  'right_index1', 'right_index2', 'right_index3',
  'right_middle1', 'right_middle2', 'right_middle3',
  'right_pinky1', 'right_pinky2', 'right_pinky3',
  'right_ring1', 'right_ring2', 'right_ring3',
  'right_thumb1', 'right_thumb2', 'right_thumb3',
];

export const SMPLX_PARENTS = [
  -1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19,
  15, 15, 15,
  20, 25, 26, 20, 28, 29, 20, 31, 32, 20, 34, 35, 20, 37, 38,
  21, 40, 41, 21, 43, 44, 21, 46, 47, 21, 49, 50, 21, 52, 53,
];

const FINGER = (side, smplx, vrm) => ({
  [`${side}_${smplx}1`]: `${side}${vrm}Proximal`,
  [`${side}_${smplx}2`]: `${side}${vrm}Intermediate`,
  [`${side}_${smplx}3`]: `${side}${vrm}Distal`,
});
const THUMB = (side) => ({
  [`${side}_thumb1`]: `${side}ThumbMetacarpal`,
  [`${side}_thumb2`]: `${side}ThumbProximal`,
  [`${side}_thumb3`]: `${side}ThumbDistal`,
});

export const SMPLX_TO_VRM = {
  pelvis: 'hips',
  left_hip: 'leftUpperLeg', right_hip: 'rightUpperLeg',
  spine1: 'spine',
  left_knee: 'leftLowerLeg', right_knee: 'rightLowerLeg',
  spine2: 'chest',
  left_ankle: 'leftFoot', right_ankle: 'rightFoot',
  spine3: 'upperChest',
  left_foot: 'leftToes', right_foot: 'rightToes',
  neck: 'neck',
  left_collar: 'leftShoulder', right_collar: 'rightShoulder',
  head: 'head',
  left_shoulder: 'leftUpperArm', right_shoulder: 'rightUpperArm',
  left_elbow: 'leftLowerArm', right_elbow: 'rightLowerArm',
  left_wrist: 'leftHand', right_wrist: 'rightHand',
  jaw: 'jaw',
  left_eye_smplhf: 'leftEye', right_eye_smplhf: 'rightEye',
  ...FINGER('left', 'index', 'Index'), ...FINGER('left', 'middle', 'Middle'),
  ...FINGER('left', 'pinky', 'Little'), ...FINGER('left', 'ring', 'Ring'), ...THUMB('left'),
  ...FINGER('right', 'index', 'Index'), ...FINGER('right', 'middle', 'Middle'),
  ...FINGER('right', 'pinky', 'Little'), ...FINGER('right', 'ring', 'Ring'), ...THUMB('right'),
};

// Approximate SMPL-X T-pose joint positions (metres, Y-up, facing +Z) for the
// stick-figure fallback.  Not the SMPL-X model's regressed joints; just a
// plausible skeleton so the stream can be viewed without any character asset.
const P = {};
P.pelvis = [0, 0.95, 0];
P.left_hip = [0.09, 0.88, 0]; P.right_hip = [-0.09, 0.88, 0];
P.left_knee = [0.10, 0.49, 0]; P.right_knee = [-0.10, 0.49, 0];
P.left_ankle = [0.10, 0.08, 0]; P.right_ankle = [-0.10, 0.08, 0];
P.left_foot = [0.11, 0.02, 0.12]; P.right_foot = [-0.11, 0.02, 0.12];
P.spine1 = [0, 1.06, 0]; P.spine2 = [0, 1.18, 0]; P.spine3 = [0, 1.32, 0];
P.neck = [0, 1.50, 0]; P.head = [0, 1.58, 0];
P.left_collar = [0.07, 1.46, 0]; P.right_collar = [-0.07, 1.46, 0];
P.left_shoulder = [0.19, 1.46, 0]; P.right_shoulder = [-0.19, 1.46, 0];
P.left_elbow = [0.45, 1.46, 0]; P.right_elbow = [-0.45, 1.46, 0];
P.left_wrist = [0.70, 1.46, 0]; P.right_wrist = [-0.70, 1.46, 0];
P.jaw = [0, 1.60, 0.03]; P.left_eye_smplhf = [0.03, 1.65, 0.08]; P.right_eye_smplhf = [-0.03, 1.65, 0.08];
const fingers = [['index', 0.03, 0.0], ['middle', 0.01, 0.0], ['ring', -0.01, 0.0], ['pinky', -0.03, 0.0]];
for (const [side, s] of [['left', 1], ['right', -1]]) {
  for (const [name, z, dy] of fingers) {
    for (let i = 1; i <= 3; i++) P[`${side}_${name}${i}`] = [s * (0.78 + 0.03 * i), 1.46 + dy, z];
  }
  for (let i = 1; i <= 3; i++) P[`${side}_thumb${i}`] = [s * (0.72 + 0.025 * i), 1.44 - 0.005 * i, 0.03 + 0.015 * i];
}
export const SMPLX_REST_POSITIONS = SMPLX_JOINT_NAMES.map((n) => P[n]);
