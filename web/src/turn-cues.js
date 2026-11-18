// The client side of the turn cue protocol (turn-cue-protocol.md): which state of the bot's turn
// is current, and when a time the bot announces will be heard by this client.
//
// The bot's times mean "when that sound leaves the server", on the bot's clock.  Nothing here compares
// that clock with this client's.  Every message says when it was sent (now_ms), so each announced
// time is used only as a lead over its own message: "this sound leaves 420 ms after this message did"
// (or a negative lead, for a sound already sent).  The same sound is heard here at
//
//   arrival of the message + its lead + sound lag (+ what comes after decoding)
//
//   arrival     Written below as `offset`: arrival − now_ms, the smallest value over the last 10 seconds.
//               The bot repeats its latest state once a second, so there are always fresh values, and
//               a message held up by the network only makes its own value larger.
//   sound lag   How much later the sound is heard than its message says.  It is not worked out from
//               parts (network, buffers); it is measured.  The client hears when the bot's sound
//               starts and stops and compares that with the start and end of each announced segment.
//               The median of the last 9 differences is the lag, once there are 3; until then a
//               starting value is used (the lag learned last time, or DEFAULT_LAG_MS).  In Chrome on
//               macOS it was 100 to 155 ms, session by session.
//               A client that plays the audio itself knows its lag and passes it in, with learnLag off.
//   after decoding  The page hears the sound on the decoded audio, before the loudspeaker.  What the
//               loudspeaker path adds (Chrome's playout figure, larger on Bluetooth headphones) and a
//               manual adjustment are passed to heardAt() as extraMs.
//
// Nothing here delays the audio.

export const DEFAULT_LAG_MS = 130;
const OFFSET_WINDOW_MS = 10000;
const LAG_SAMPLES = 9;
const LAG_MIN_SAMPLES = 3;       // fewer than this, and the starting value stands
const LAG_MATCH_MS = 250;        // a sound heard within this of where the present lag puts a boundary is that boundary
const LAG_RANGE = [0, 600];

export class CueTracker {
  /**
   * lagMs: the starting sound lag.  learnLag: false for a client that knows its lag itself (a robot
   * that plays the audio it receives); its clock is then trusted as soon as the offset is known.
   */
  constructor({ lagMs = DEFAULT_LAG_MS, learnLag = true } = {}) { this.startLagMs = lagMs; this.learnLag = learnLag; this.reset(); }

  reset() {
    this.samples = [];            // [arrival, arrival − now_ms]
    this.offsetMs = NaN;
    this.state = null;            // the newest message for the newest turn
    this.lastArrival = NaN;       // any message, repeats included
    this.changedAt = NaN;         // arrival of the newest state that was not a repeat
    this.textAt = new Map();      // turn -> arrival of its first message with text_started
    this.messages = 0;
    this.lagSamples = [];         // heard minus announced (as arrival plus lead), newest last
    this.lagMs = this.startLagMs;
  }

  /**
   * One bot-turn-cue message, arrived at local time `arrival` (performance.now()).
   * @returns true if it carried a new state, false for a repeat, an old state or another version.
   */
  observe(m, arrival) {
    if (!m || m.v !== 1 || !Number.isFinite(m.now_ms)) return false;
    this.messages++;
    this.lastArrival = arrival;
    this.samples.push([arrival, arrival - m.now_ms]);
    while (this.samples.length && this.samples[0][0] < arrival - OFFSET_WINDOW_MS) this.samples.shift();
    this.offsetMs = Math.min(...this.samples.map((s) => s[1]));
    if (m.text_started && !this.textAt.has(m.turn)) this.textAt.set(m.turn, arrival);
    // (turn, rev), not arrival order, decides which state is current.
    const s = this.state;
    if (s && (m.turn < s.turn || (m.turn === s.turn && m.rev <= s.rev))) return false;
    this.state = m;
    this.changedAt = arrival;
    return true;
  }

  /**
   * Local time at which sound that leaves the server at `serverMs` is heard here; NaN if unknown.
   * @param extraMs  what is added after the point where this client hears the sound (see the top of the file)
   */
  heardAt(serverMs, extraMs = 0) {
    if (serverMs === null || serverMs === undefined || !Number.isFinite(this.offsetMs)) return NaN;
    return serverMs + this.offsetMs + this.lagMs + (Number.isFinite(extraMs) ? extraMs : 0);
  }

  /**
   * The client heard the bot's sound start ('on') or stop ('off') at local time t.
   * If an announced segment boundary of the current turn is near, it is one more measurement of the lag.
   * @returns the lag measured, or null
   */
  heard(kind, t) {
    const m = this.state;
    if (!this.learnLag || !m || !m.segments?.length || !Number.isFinite(this.offsetMs)) return null;
    let best = null;
    for (const seg of m.segments) {
      const at = kind === 'on' ? seg.start_ms : seg.end_ms;
      if (at === null || at === undefined) continue;
      const lag = t - (at + this.offsetMs);
      if (Math.abs(lag - this.lagMs) <= LAG_MATCH_MS && (best === null || Math.abs(lag - this.lagMs) < Math.abs(best - this.lagMs))) best = lag;
    }
    if (best === null) return null;
    this.lagSamples.push(best);
    if (this.lagSamples.length > LAG_SAMPLES) this.lagSamples.shift();
    if (this.lagLearned) {
      const sorted = [...this.lagSamples].sort((a, b) => a - b);
      this.lagMs = Math.min(LAG_RANGE[1], Math.max(LAG_RANGE[0], sorted[sorted.length >> 1]));
    }
    return best;
  }

  /** Whether the lag in use was measured in this session (false: still the starting value). */
  get lagLearned() { return this.lagSamples.length >= LAG_MIN_SAMPLES; }

  /** Whether announced times can be trusted to within a few tens of milliseconds: the lag is measured, or known. */
  get clockReady() { return Number.isFinite(this.offsetMs) && (!this.learnLag || this.lagLearned); }

  /** Whether messages are still coming (the bot repeats its state once a second). */
  live(now, quietMs = 3000) { return Number.isFinite(this.lastArrival) && now - this.lastArrival < quietMs; }
}
