// Audio playout-delay estimation from RTCPeerConnection.getStats(), the
// motion playhead clock, and a cross-correlation probe that measures the
// residual audio <-> motion lag from what actually comes out of the speaker.

export class AudioDelayEstimator {
  constructor(getPc) {
    this.getPc = getPc;
    this.jitterMs = NaN; this.rttMs = NaN; this.playoutMs = NaN; this.totalMs = NaN;
    this._prevJb = null; this._prevPo = null;
  }

  /** Estimated delay from packet arrival to loudspeaker: jb + RTT/2 + playout. */
  async update() {
    const pc = this.getPc();
    if (!pc) return;
    let report;
    try { report = await pc.getStats(); } catch { return; }
    let inbound = null, transport = null, playout = null, pair = null;
    report.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'audio') inbound = s;
      else if (s.type === 'transport') transport = s;
      else if (s.type === 'media-playout') playout = s;
    });
    if (transport?.selectedCandidatePairId) pair = report.get(transport.selectedCandidatePairId);
    if (!pair) report.forEach((s) => { if (!pair && s.type === 'candidate-pair' && s.nominated && s.currentRoundTripTime != null) pair = s; });

    if (inbound && inbound.jitterBufferEmittedCount > 0) {
      const d = inbound.jitterBufferDelay, c = inbound.jitterBufferEmittedCount;
      // windowed average over the last stats interval (cumulative counters)
      if (this._prevJb && c > this._prevJb.c) this.jitterMs = ((d - this._prevJb.d) / (c - this._prevJb.c)) * 1000;
      else this.jitterMs = (d / c) * 1000;
      this._prevJb = { d, c };
    }
    if (pair?.currentRoundTripTime != null) this.rttMs = pair.currentRoundTripTime * 1000;
    if (playout && playout.totalSamplesCount > 0) {
      const d = playout.totalPlayoutDelay, c = playout.totalSamplesCount;
      if (this._prevPo && c > this._prevPo.c) this.playoutMs = ((d - this._prevPo.d) / (c - this._prevPo.c)) * 1000;
      else this.playoutMs = (d / c) * 1000;
      this._prevPo = { d, c };
    }
    const z = (x) => (Number.isFinite(x) ? x : 0);
    this.totalMs = z(this.jitterMs) + z(this.rttMs) / 2 + z(this.playoutMs);
  }
}

/**
 * Maps the agent's audio timeline (pts_ms) to local time.
 *
 * Each motion message arriving at local time t carries pts; d = t - pts is
 * roughly constant (the server generates in real time) plus network jitter.
 * The median of d over the last window is the arrival offset; audio for the
 * same pts leaves the speaker audioDelay later.  So the pose to show now is
 * the one whose pts == now - offset - audioDelay - trim.
 */
export class PlayoutClock {
  constructor(windowSize = 25) {
    this.window = []; this.windowSize = windowSize;
    this.offsetMs = NaN; this.minOffsetMs = NaN; this.audioDelayMs = 0; this.trimMs = 0; this.autoTrimMs = 0;
  }
  observe(pts, tArrival) {
    const d = tArrival - pts;
    this.window.push(d);
    if (this.window.length > this.windowSize) this.window.shift();
    const sorted = [...this.window].sort((a, b) => a - b);
    this.offsetMs = sorted[sorted.length >> 1];
    this.minOffsetMs = sorted[0];
  }
  get jitterMs() { return this.offsetMs - this.minOffsetMs; }
  playhead(tNow) {
    if (!Number.isFinite(this.offsetMs)) return NaN;
    return tNow - this.offsetMs - this.audioDelayMs - this.trimMs - this.autoTrimMs;
  }
  reset() { this.window.length = 0; this.offsetMs = NaN; this.minOffsetMs = NaN; this.autoTrimMs = 0; }
}

/**
 * Cross-correlates the loudspeaker audio envelope with the rendered jaw
 * opening to measure how far motion is from audio, in ms (positive: motion
 * late).  Both signals are sampled on a 10 ms grid.
 */
export class SyncProbe {
  constructor({ gridMs = 10, windowS = 4, maxLagMs = 400 } = {}) {
    this.gridMs = gridMs; this.n = Math.round((windowS * 1000) / gridMs); this.maxLag = Math.round(maxLagMs / gridMs);
    this.audio = new Float32Array(this.n); this.motion = new Float32Array(this.n);
    this.idx = 0; this.filled = 0; this.lastSlot = -1;
    this.lagMs = NaN; this.corr = NaN; this.analyser = null; this.buf = null; this.ctx = null;
  }
  attachTrack(track) {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const src = this.ctx.createMediaStreamSource(new MediaStream([track]));
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.buf = new Float32Array(this.analyser.fftSize);
    src.connect(this.analyser); // not connected to destination: the <audio> element plays it
  }
  audioLevel() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.buf);
    let s = 0; const b = this.buf, n = 480; // last ~10 ms at 48 kHz
    for (let i = b.length - n; i < b.length; i++) s += b[i] * b[i];
    return Math.sqrt(s / n);
  }
  /** Call every animation frame with the jaw opening of the pose being rendered. */
  sample(tNow, jawOpen) {
    const slot = Math.floor(tNow / this.gridMs);
    if (slot === this.lastSlot) return;
    this.lastSlot = slot;
    this.audio[this.idx] = this.audioLevel();
    this.motion[this.idx] = jawOpen;
    this.idx = (this.idx + 1) % this.n;
    this.filled = Math.min(this.filled + 1, this.n);
  }
  /** Recompute lag; returns {lagMs, corr} or null when signals are flat. */
  compute() {
    if (this.filled < this.n) return null;
    const n = this.n, a = new Float32Array(n), m = new Float32Array(n);
    for (let i = 0; i < n; i++) { const j = (this.idx + i) % n; a[i] = this.audio[j]; m[i] = this.motion[j]; }
    const norm = (x) => { let mu = 0; for (const v of x) mu += v; mu /= x.length; let ss = 0; for (let i = 0; i < x.length; i++) { x[i] -= mu; ss += x[i] * x[i]; } return Math.sqrt(ss); };
    const na = norm(a), nm = norm(m);
    if (na < 1e-6 || nm < 1e-6) return null;
    let best = -Infinity, bestLag = 0;
    for (let lag = -this.maxLag; lag <= this.maxLag; lag++) {
      // positive lag: motion[i + lag] matches audio[i]  => motion is late by lag
      let s = 0;
      for (let i = Math.max(0, -lag); i < n - Math.max(0, lag); i++) s += a[i] * m[i + lag];
      s /= na * nm;
      if (s > best) { best = s; bestLag = lag; }
    }
    this.lagMs = bestLag * this.gridMs; this.corr = best;
    return { lagMs: this.lagMs, corr: best };
  }
}
