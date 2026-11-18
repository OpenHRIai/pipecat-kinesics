import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import fs from 'node:fs';

// VITE_HTTPS=1 npm run dev   -> self-signed HTTPS (needed for the mic on non-localhost hosts)
// BOT_URL=http://gpu-box:7860 -> where the Pipecat bot's /api/offer lives (proxied, same-origin)
const https = process.env.VITE_HTTPS === '1';
// A script that starts a bot elsewhere can write the bot's address to .bot-url; it is read at start.
// BOT_URL_FILE picks another such file.
const botUrlFile = new URL(process.env.BOT_URL_FILE || './.bot-url', import.meta.url);
const fromFile = fs.existsSync(botUrlFile) ? fs.readFileSync(botUrlFile, 'utf8').trim() : '';
const botUrl = process.env.BOT_URL || fromFile || 'http://localhost:7860';
// A bot on another network is reached through NAT (network address translation), so the
// browser must ask a STUN server for its own public address.  A local bot needs none.
const remoteBot = !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(botUrl);
const iceServers = remoteBot ? [{ urls: 'stun:stun.l.google.com:19302' }] : [];

export default defineConfig({
  plugins: https ? [basicSsl()] : [],
  // MuJoCo's package finds its .wasm file relative to its own script; pre-bundling would break that.
  optimizeDeps: { exclude: ['@mujoco/mujoco'] },
  define: { __BOT_URL__: JSON.stringify(botUrl), __ICE_SERVERS__: JSON.stringify(iceServers) },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: botUrl, changeOrigin: true },
    },
  },
});
