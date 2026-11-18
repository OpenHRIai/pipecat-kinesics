// The acoustic check finds the delay between the decoded bot audio and the room microphone.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AcousticCheck } from '../src/acoustic.js';

function feed(check, rate, seconds, botAt, roomAt) {
  // Bursts of noise at the given times (seconds) in each channel, quiet room noise elsewhere.
  const n = Math.round(rate * seconds), block = 1024;
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  const inBurst = (t, at) => at.some((s) => t >= s && t < s + 0.25);
  for (let off = 0; off < n; off += block) {
    const a = new Float32Array(block), b = new Float32Array(block);
    for (let i = 0; i < block; i++) {
      const t = (off + i) / rate;
      a[i] = inBurst(t, botAt) ? 0.5 * rnd() : 0;
      b[i] = (inBurst(t, roomAt) ? 0.2 * rnd() : 0) + 0.002 * rnd();
    }
    check._process({ getChannelData: (c) => (c === 0 ? a : b) });
  }
}

test('the lag at the best match is the delay of the room behind the bot', () => {
  const check = new AcousticCheck(() => {});
  check.per = 480; // 10 ms at 48,000 samples per second
  const bot = [0.3, 0.9, 1.6, 2.2, 2.7, 3.5, 4.1, 4.8, 5.4];
  const delay = 0.180;
  feed(check, 48000, 6.0, bot, bot.map((t) => t + delay));
  check._correlate();
  assert.ok(check.last, 'a result');
  assert.ok(Math.abs(check.last.lagMs - 180) <= 10, `lag ${check.last.lagMs} ms`);
  assert.ok(check.last.corr > 0.8, `match ${check.last.corr}`);
});

test('nothing is reported while the bot is silent', () => {
  const check = new AcousticCheck(() => {});
  check.per = 480;
  feed(check, 48000, 6.0, [], [1.0, 2.0]);
  check._correlate();
  assert.equal(check.last, null);
});
