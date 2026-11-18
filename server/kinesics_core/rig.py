"""Skeleton convention and wire packing for the pose stream.

The server-side pose representation is the SMPL-X joint set: 55 joints (22 body, 1 jaw, 2 eyes, 30 finger joints) as local
axis-angle rotations, 100 FLAME-style expression coefficients and a root
translation.  Nothing from the SMPL-X *body model* (mesh, shape blendshapes,
skinning weights) is used or shipped; only joint rotations leave the server.

Wire format (``v=1``, JSON over the RTVI data channel), all arrays are flat int16 lists, frame-major,
``n`` pose frames per message::

    {
      "t": "motion", "v": 1, "seq": 812, "pts_ms": 64960, "dt_ms": 40, "n": 2,
      "rig": "smplx:body22q+hands30q+face1q100e+root7",
      "body":  [ n * 22 * 4 ],   # joints 0..21, quaternion xyzw * 32767
      "hands": [ n * 30 * 4 ],   # joints 25..54, quaternion xyzw * 32767  (optional)
      "face":  [ n * (4 + 100) ],# jaw quaternion * 32767, then 100 expr * 1000 (optional)
      "root":  [ n * 7 ],        # tx,ty,tz in mm, then global-orient quaternion * 32767 (optional)
      "flags": {"speaking": true, "interrupted": false}
    }

``pts_ms`` is the position of the first pose frame on the agent's output-audio
timeline (output samples emitted before it / 24).  ``root[3:7]`` duplicates
``body[0:4]`` (the pelvis rotation *is* SMPL-X's global orientation) so that a
consumer that only wants the root transform does not have to parse ``body``.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# fmt: off
SMPLX_JOINT_NAMES = [
    "pelvis", "left_hip", "right_hip", "spine1", "left_knee", "right_knee",
    "spine2", "left_ankle", "right_ankle", "spine3", "left_foot", "right_foot",
    "neck", "left_collar", "right_collar", "head", "left_shoulder",
    "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist",
    "jaw", "left_eye_smplhf", "right_eye_smplhf",
    "left_index1", "left_index2", "left_index3",
    "left_middle1", "left_middle2", "left_middle3",
    "left_pinky1", "left_pinky2", "left_pinky3",
    "left_ring1", "left_ring2", "left_ring3",
    "left_thumb1", "left_thumb2", "left_thumb3",
    "right_index1", "right_index2", "right_index3",
    "right_middle1", "right_middle2", "right_middle3",
    "right_pinky1", "right_pinky2", "right_pinky3",
    "right_ring1", "right_ring2", "right_ring3",
    "right_thumb1", "right_thumb2", "right_thumb3",
]
# Standard SMPL-X kinematic tree (parent index per joint).
SMPLX_PARENTS = [
    -1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19,
    15, 15, 15,
    20, 25, 26, 20, 28, 29, 20, 31, 32, 20, 34, 35, 20, 37, 38,
    21, 40, 41, 21, 43, 44, 21, 46, 47, 21, 49, 50, 21, 52, 53,
]
# fmt: on

N_JOINTS = 55
BODY_JOINTS = list(range(0, 22))  # pelvis .. right_wrist
JAW_JOINT = 22
EYE_JOINTS = [23, 24]
HAND_JOINTS = list(range(25, 55))  # 30 finger joints
N_EXPR = 100

J = {name: i for i, name in enumerate(SMPLX_JOINT_NAMES)}

WIRE_VERSION = 1
RIG = "smplx:body22q+hands30q+face1q100e+root7"
Q_SCALE = 32767.0  # unit quaternion component -> int16
EXPR_SCALE = 1000.0  # expression coefficient -> int16 (range +-32.767)
MM = 1000.0  # metres -> millimetres

INT16_MIN, INT16_MAX = -32768, 32767


@dataclass
class PoseFrames:
    """``n`` consecutive pose frames at 25 fps.

    quats:  (n, 55, 4) float32, local joint rotations as xyzw unit quaternions.
    expr:   (n, 100) float32 or None.
    transl: (n, 3) float32 root translation in metres, or None.
    """

    quats: np.ndarray
    expr: np.ndarray | None = None
    transl: np.ndarray | None = None

    @property
    def n(self) -> int:
        return int(self.quats.shape[0])

    @staticmethod
    def rest(n: int) -> "PoseFrames":
        q = np.zeros((n, N_JOINTS, 4), dtype=np.float32)
        q[..., 3] = 1.0
        return PoseFrames(q, np.zeros((n, N_EXPR), np.float32), np.zeros((n, 3), np.float32))


def axis_angle_to_quat(aa: np.ndarray) -> np.ndarray:
    """Rodrigues axis-angle (..., 3) -> unit quaternion (..., 4) as xyzw.

    Matches three.js ``Quaternion.setFromAxisAngle(axis, angle)``.
    """
    aa = np.asarray(aa, dtype=np.float64)
    angle = np.linalg.norm(aa, axis=-1, keepdims=True)
    half = 0.5 * angle
    # sin(half)/angle with a series fallback near zero.
    small = angle < 1e-6
    safe = np.where(small, 1.0, angle)
    k = np.where(small, 0.5 - angle**2 / 48.0, np.sin(half) / safe)
    xyz = aa * k
    w = np.cos(half)
    return np.concatenate([xyz, w], axis=-1).astype(np.float32)


def quat_multiply(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Hamilton product a*b for xyzw quaternions (broadcasting)."""
    ax, ay, az, aw = np.moveaxis(a, -1, 0)
    bx, by, bz, bw = np.moveaxis(b, -1, 0)
    return np.stack(
        [
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz,
        ],
        axis=-1,
    )


def _q16(x: np.ndarray, scale: float) -> np.ndarray:
    return np.clip(np.rint(np.asarray(x, dtype=np.float64) * scale), INT16_MIN, INT16_MAX).astype(np.int16)


def pack_pose_frames(
    poses: PoseFrames, *, include_hands: bool = True, include_face: bool = True, include_root: bool = True
) -> dict:
    """Quantize ``poses`` into the wire arrays (without the header fields)."""
    q = poses.quats
    n = q.shape[0]
    assert q.shape == (n, N_JOINTS, 4), q.shape
    out: dict = {"body": _q16(q[:, BODY_JOINTS, :], Q_SCALE).ravel().tolist()}
    if include_hands:
        out["hands"] = _q16(q[:, HAND_JOINTS, :], Q_SCALE).ravel().tolist()
    if include_face:
        jaw = _q16(q[:, JAW_JOINT, :], Q_SCALE)  # (n, 4)
        expr = poses.expr if poses.expr is not None else np.zeros((n, N_EXPR), np.float32)
        face = np.concatenate([jaw, _q16(expr, EXPR_SCALE)], axis=1)  # (n, 104)
        out["face"] = face.ravel().tolist()
    if include_root:
        transl = poses.transl if poses.transl is not None else np.zeros((n, 3), np.float32)
        root = np.concatenate([_q16(transl, MM), _q16(q[:, 0, :], Q_SCALE)], axis=1)  # (n, 7)
        out["root"] = root.ravel().tolist()
    return out


def unpack_pose_frames(msg: dict) -> PoseFrames:
    """Inverse of :func:`pack_pose_frames` (used by tests and offline tools)."""
    n = int(msg["n"])
    q = np.zeros((n, N_JOINTS, 4), np.float32)
    q[..., 3] = 1.0
    q[:, BODY_JOINTS, :] = np.asarray(msg["body"], np.float32).reshape(n, 22, 4) / Q_SCALE
    if "hands" in msg:
        q[:, HAND_JOINTS, :] = np.asarray(msg["hands"], np.float32).reshape(n, 30, 4) / Q_SCALE
    expr = None
    if "face" in msg:
        face = np.asarray(msg["face"], np.float32).reshape(n, 4 + N_EXPR)
        q[:, JAW_JOINT, :] = face[:, :4] / Q_SCALE
        expr = face[:, 4:] / EXPR_SCALE
    transl = None
    if "root" in msg:
        root = np.asarray(msg["root"], np.float32).reshape(n, 7)
        transl = root[:, :3] / MM
    return PoseFrames(q, expr, transl)
