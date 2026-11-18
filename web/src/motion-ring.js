// Ring buffer of pose frames keyed by pts_ms, with slerp sampling at an
// arbitrary playhead position on the agent's audio timeline.

function slerpQuat(out, o, a, ao, b, bo, t) {
  let ax = a[ao], ay = a[ao + 1], az = a[ao + 2], aw = a[ao + 3];
  let bx = b[bo], by = b[bo + 1], bz = b[bo + 2], bw = b[bo + 3];
  let cos = ax * bx + ay * by + az * bz + aw * bw;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let ka, kb;
  if (cos > 0.9995) { ka = 1 - t; kb = t; }
  else {
    const th = Math.acos(cos), s = Math.sin(th);
    ka = Math.sin((1 - t) * th) / s; kb = Math.sin(t * th) / s;
  }
  const x = ka * ax + kb * bx, y = ka * ay + kb * by, z = ka * az + kb * bz, w = ka * aw + kb * bw;
  const n = Math.hypot(x, y, z, w) || 1;
  out[o] = x / n; out[o + 1] = y / n; out[o + 2] = z / n; out[o + 3] = w / n;
}

function slerpArray(a, b, t) {
  if (!a) return b; if (!b) return a;
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i += 4) slerpQuat(out, i, a, i, b, i, t);
  return out;
}

function lerpArray(a, b, t) {
  if (!a) return b; if (!b) return a;
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}

export class MotionRing {
  constructor(capacity = 150) {
    this.capacity = capacity;   // 150 frames = 6 s at 25 fps
    this.frames = [];           // sorted by pts
    this.late = 0;              // frames that arrived after their playout time
    this.starved = 0;           // samples taken beyond the newest frame
    this.lastPlayhead = -Infinity;
  }

  push(frame, playheadAtArrival) {
    if (Number.isFinite(playheadAtArrival) && frame.pts < playheadAtArrival) this.late++;
    const fr = this.frames;
    if (fr.length === 0 || fr[fr.length - 1].pts < frame.pts) fr.push(frame);
    else {
      // out-of-order arrival: insert sorted, replace duplicates
      let i = fr.length - 1;
      while (i >= 0 && fr[i].pts > frame.pts) i--;
      if (i >= 0 && fr[i].pts === frame.pts) fr[i] = frame; else fr.splice(i + 1, 0, frame);
    }
    if (fr.length > this.capacity) fr.splice(0, fr.length - this.capacity);
  }

  clear() { this.frames.length = 0; this.late = 0; this.starved = 0; }

  get newestPts() { return this.frames.length ? this.frames[this.frames.length - 1].pts : NaN; }
  get oldestPts() { return this.frames.length ? this.frames[0].pts : NaN; }

  /** Interpolated pose at playhead pts (ms). Returns null when empty. */
  sample(pts) {
    const fr = this.frames;
    if (fr.length === 0) return null;
    this.lastPlayhead = pts;
    // drop frames well behind the playhead (keep one for interpolation)
    let drop = 0;
    while (drop + 1 < fr.length && fr[drop + 1].pts <= pts) drop++;
    if (drop > 0) fr.splice(0, drop);
    const f0 = fr[0];
    if (pts <= f0.pts) return { ...f0, status: 'ahead', f0, f1: f0 };
    const f1 = fr[1];
    if (!f1) { this.starved++; return { ...f0, status: 'starved', f0, f1: f0 }; }
    const t = Math.min(1, Math.max(0, (pts - f0.pts) / (f1.pts - f0.pts)));
    return {
      pts,
      body: slerpArray(f0.body, f1.body, t),
      hands: slerpArray(f0.hands, f1.hands, t),
      jaw: slerpArray(f0.jaw, f1.jaw, t),
      expr: lerpArray(f0.expr, f1.expr, t),
      root: f0.root && f1.root ? { t: [0, 1, 2].map(i => f0.root.t[i] + (f1.root.t[i] - f0.root.t[i]) * t), q: slerpArray(f0.root.q, f1.root.q, t) } : (f0.root || null),
      speaking: t < 0.5 ? f0.speaking : f1.speaking,
      interrupted: f0.interrupted || f1.interrupted,
      status: 'ok', f0, f1,
    };
  }
}
