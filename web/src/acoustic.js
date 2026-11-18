// Acoustic check: how long after the browser decodes the bot's audio is it actually heard?
//
// Chrome reports a "playout delay" (the time from decoding to the loudspeaker), but that is its own
// estimate.  This measures it through the air instead.  One Web Audio graph takes two inputs:
//
//   left:  the bot's audio track as decoded, before the loudspeaker (the same point the page's
//          other analysers read)
//   right: the room, recorded by the microphone with echo cancellation, noise suppression and
//          automatic gain turned off, so the bot's own voice is not removed from it
//
// Both reach the graph through one audio callback, so their envelopes are aligned sample for
// sample.  Every second the last 4 seconds of the two envelopes are cross-correlated; the lag at
// the peak is how much later the room hears the bot than the browser decoded it:
//
//   lag = loudspeaker path + sound travelling through the air (about 1 ms per 34 cm)
//         + the microphone's own input path
//
// The microphone's input path is unknown but the same from one run to the next on the same computer,
// so two runs differing only in where the bot runs show whether a difference in Chrome's playout
// figure is a difference the listener hears.  Needs loudspeakers (not headphones)
// and a quiet room.  Turned on with ?acoustic=1 in the page address.

const ENV_MS = 10;            // envelope resolution
const WINDOW_S = 4;           // correlation window
const MAX_LAG_MS = 800;       // the room can only lag the decoded audio, by at most this much
const HISTORY_S = 8;

export class AcousticCheck {
  constructor(log) {
    this.log = log;
    this.ctx = null; this.bot = null; this.room = null; this.node = null;
    this.n = Math.round((HISTORY_S * 1000) / ENV_MS);
    this.botEnv = new Float32Array(this.n); this.roomEnv = new Float32Array(this.n);
    this.idx = 0; this.filled = 0;
    this.acc = [0, 0]; this.accN = 0; this.per = 0;
    this.results = [];        // [{t, lagMs, corr}] waiting to be reported
    this.last = null;
    this.shown = 0;
  }

  /** Open the room microphone, unprocessed.  ``getUserMedia`` must be the browser's own one. */
  async start(getUserMedia) {
    if (this.ctx) return;
    // The microphone first: if it is refused, nothing else is set up and the page carries on without the check.
    const stream = await getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    this.ctx = new AudioContext();
    await this.ctx.resume();
    this.roomStream = stream;
    this.room = this.ctx.createMediaStreamSource(stream);
    this.per = Math.round((this.ctx.sampleRate * ENV_MS) / 1000);
    this.merger = this.ctx.createChannelMerger(2);
    this.room.connect(this.merger, 0, 1);
    // A ScriptProcessorNode is deprecated but delivers both inputs in one callback, which is all
    // this needs; its own latency does not matter because both inputs share it.
    this.node = this.ctx.createScriptProcessor(1024, 2, 1);
    this.node.onaudioprocess = (e) => this._process(e.inputBuffer);
    this.merger.connect(this.node);
    const mute = this.ctx.createGain(); mute.gain.value = 0;
    this.node.connect(mute).connect(this.ctx.destination);
    this.timer = setInterval(() => this._correlate(), 1000);
    this.log(`acoustic check on: room microphone "${stream.getAudioTracks()[0]?.label}", unprocessed, ${this.ctx.sampleRate} samples per second`);
  }

  /** The bot's remote audio track. */
  attachBot(track) {
    if (!this.merger) return;   // the check is off, or the microphone was refused
    this.bot?.disconnect();
    this.bot = this.ctx.createMediaStreamSource(new MediaStream([track]));
    this.bot.connect(this.merger, 0, 0);
  }

  stop() {
    clearInterval(this.timer);
    this.roomStream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    this.ctx = null; this.bot = null; this.room = null; this.merger = null; this.filled = 0;
  }

  _process(buf) {
    const a = buf.getChannelData(0), b = buf.getChannelData(1);
    for (let i = 0; i < a.length; i++) {
      this.acc[0] += a[i] * a[i]; this.acc[1] += b[i] * b[i];
      if (++this.accN === this.per) {
        this.botEnv[this.idx] = Math.sqrt(this.acc[0] / this.per);
        this.roomEnv[this.idx] = Math.sqrt(this.acc[1] / this.per);
        this.idx = (this.idx + 1) % this.n; this.filled = Math.min(this.filled + 1, this.n);
        this.acc[0] = this.acc[1] = 0; this.accN = 0;
      }
    }
  }

  _correlate() {
    const w = Math.round((WINDOW_S * 1000) / ENV_MS), maxLag = Math.round(MAX_LAG_MS / ENV_MS);
    if (this.filled < w + maxLag) return;
    // The bot window ends maxLag before now, so every lag up to maxLag has room data after it.
    const end = (this.idx - maxLag + this.n) % this.n;
    const bot = new Float32Array(w);
    for (let i = 0; i < w; i++) bot[i] = this.botEnv[(end - w + i + this.n) % this.n];
    const norm = (x) => { let mu = 0; for (const v of x) mu += v; mu /= x.length; let ss = 0; for (let i = 0; i < x.length; i++) { x[i] -= mu; ss += x[i] * x[i]; } return Math.sqrt(ss); };
    const nb = norm(bot);
    if (nb < 1e-4) return;   // the bot was silent: nothing to measure
    let best = -Infinity, bestLag = 0;
    for (let lag = 0; lag <= maxLag; lag++) {
      const room = new Float32Array(w);
      for (let i = 0; i < w; i++) room[i] = this.roomEnv[(end - w + i + lag + this.n) % this.n];
      const nr = norm(room);
      if (nr < 1e-6) continue;
      let s = 0;
      for (let i = 0; i < w; i++) s += bot[i] * room[i];
      s /= nb * nr;
      if (s > best) { best = s; bestLag = lag; }
    }
    if (!Number.isFinite(best)) return;
    this.last = { t: Math.round(performance.now()), lagMs: bestLag * ENV_MS, corr: Math.round(best * 1000) / 1000 };
    this.results.push(this.last);
    if (best >= 0.5 && ++this.shown % 5 === 1) this.log(`acoustic check: the room hears the bot ${this.last.lagMs} ms after it is decoded (match ${this.last.corr.toFixed(2)})`);
  }

  /** Results since the last call, for the report to the recorder. */
  take() { return this.results.splice(0); }
}
