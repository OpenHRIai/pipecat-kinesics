// Decoder for the v1 motion message (see server/kinesics_core/rig.py for the schema).
//
// Every quaternion is xyzw * 32767, translation is millimetres, expression
// coefficients are * 1000.  All arrays are frame-major.

export const Q_SCALE = 32767;
export const EXPR_SCALE = 1000;
export const N_BODY = 22;
export const N_HANDS = 30;
export const N_EXPR = 100;

function i16ToFloat(arr, offset, count, scale, out) {
  for (let i = 0; i < count; i++) out[i] = arr[offset + i] / scale;
  return out;
}

/** Split a motion message into per-pose-frame records. */
export function decodeMotion(msg) {
  const n = msg.n | 0;
  const frames = [];
  for (let k = 0; k < n; k++) {
    const f = {
      seq: msg.seq,
      pts: msg.pts_ms + k * msg.dt_ms,
      body: i16ToFloat(msg.body, k * N_BODY * 4, N_BODY * 4, Q_SCALE, new Float32Array(N_BODY * 4)),
      hands: null,
      jaw: null,
      expr: null,
      root: null,
      speaking: !!msg.flags?.speaking,
      interrupted: !!msg.flags?.interrupted,
    };
    if (msg.hands) f.hands = i16ToFloat(msg.hands, k * N_HANDS * 4, N_HANDS * 4, Q_SCALE, new Float32Array(N_HANDS * 4));
    if (msg.face) {
      const base = k * (4 + N_EXPR);
      f.jaw = i16ToFloat(msg.face, base, 4, Q_SCALE, new Float32Array(4));
      f.expr = i16ToFloat(msg.face, base + 4, N_EXPR, EXPR_SCALE, new Float32Array(N_EXPR));
    }
    if (msg.root) {
      const base = k * 7;
      f.root = {
        t: [msg.root[base] / 1000, msg.root[base + 1] / 1000, msg.root[base + 2] / 1000],
        q: i16ToFloat(msg.root, base + 3, 4, Q_SCALE, new Float32Array(4)),
      };
    }
    frames.push(f);
  }
  return frames;
}

/** Jaw opening angle in radians (0 = closed) from the jaw quaternion. */
export function jawAngle(frame) {
  if (!frame?.jaw) return 0;
  const w = Math.min(1, Math.max(-1, frame.jaw[3]));
  return 2 * Math.acos(Math.abs(w));
}
