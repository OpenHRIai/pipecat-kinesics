// pipecat-kinesics web client: Pipecat JS client over SmallWebRTC, motion ring,
// audio-delay estimation, VRM avatar, and on-screen measurements.
//
// One connection and one pose stream drive two bodies: the avatar, and the
// robot view (a Unitree G1 simulated in MuJoCo inside this page, src/robot/).

import { PipecatClient } from '@pipecat-ai/client-js';
import { SmallWebRTCTransport } from '@pipecat-ai/small-webrtc-transport';
import loadMujoco from '@mujoco/mujoco';
import { AcousticCheck } from './acoustic.js';
import { AvatarView } from './avatar.js';
import { MotionRing } from './motion-ring.js';
import { AudioDelayEstimator, PlayoutClock, SyncProbe } from './sync.js';
import { decodeMotion, jawAngle } from './wire.js';
import { loadG1 } from './robot/g1-model.js';
import { RobotLoop } from './robot/robot-loop.js';
import { RobotView } from './robot/robot-view.js';
import { keyPoses, TurnRealizer } from './robot/turn-realizer.js';
import { CueTracker } from './turn-cues.js';
import { KinesicsRealizer } from './kinesics/kinesics-realizer.js';
import { VrmKinesics } from './kinesics/vrm-adapter.js';
import { G1Kinesics } from './kinesics/g1-adapter.js';
import PROFILES from './kinesics/profiles.json' with { type: 'json' };
import MAPPINGS from './kinesics/mappings.json' with { type: 'json' };
import { pickMapping } from './kinesics/mapping.js';

const $ = (id) => document.getElementById(id);
const logEl = $('log');
function log(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  console.log('[kinesics]', line);
  logEl.textContent = (line + '\n' + logEl.textContent).slice(0, 4000);
}
const fmt = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '–');

// ---------------------------------------------------------------- avatar
const avatar = new AvatarView($('view'));
// Head, eyes, hand and torso lean from the bot's turn cues (src/kinesics/), for a bot that sends no poses.
// ?setting=same_room picks the profile measured in the same room (default: video_call); ?frame=face
// moves the camera to head and shoulders.  Which joint or bone shows what is a client-side mapping
// (src/kinesics/mappings.json): ?g1map=forward and ?vrmmap=<name> pick one for this session.
const pageParams = new URLSearchParams(location.search);
const vrmMapping = pickMapping(MAPPINGS, 'vrm', pageParams.get('vrmmap'));
const g1Mapping = pickMapping(MAPPINGS, 'g1', pageParams.get('g1map'));
const kinesics = new KinesicsRealizer(PROFILES, { setting: pageParams.get('setting') || 'video_call', headReturnsWithEyes: !!vrmMapping.head_returns_with_eyes });
let vrmKinesics = null;
window.__kinesics = { realizer: kinesics, avatar };   // for looking at poses from the browser console
let mouthShown = 0;
// The avatar model: a .vrm file in web/public, chosen per session with ?vrm=<name> (no folder, no .vrm).
const vrmName = /^[\w-]+$/.test(pageParams.get('vrm') || '') ? pageParams.get('vrm') : 'riki_minami';
avatar.loadVRM(`/${vrmName}.vrm`).then((vrm) => {
  log(avatar.status);
  vrmKinesics = new VrmKinesics(vrm, vrmMapping);
  if (pageParams.get('frame') === 'face') avatar.frameFace();
}).catch((e) => log('no VRM (using stick figure):', e.message));

// ---------------------------------------------------------------- robot view
// Loaded the first time the robot is the selected embodiment; the connection does not wait for it.
const robotView = new RobotView($('robot-view'));
let robot = null; // RobotLoop, once MuJoCo and the G1 model are ready
let realizer = null; // TurnRealizer: the first demo of turn cues on the robot (arms and a torso turn), kept as ?robot=demo
let g1Kinesics = null; // G1Kinesics: the robot's turn cues from the measured head, eye and hand profiles (src/kinesics/)
let robotLoading = null;
const ensureRobot = () => (robotLoading ||= (async () => {
  const status = $('robot-status');
  const t0 = performance.now();
  try {
    const mujoco = await loadMujoco();
    const { model, bytes } = await loadG1(
      mujoco,
      async (rel) => {
        const res = await fetch(`/g1/${rel}`);
        // A missing file comes back as the app's own HTML page, not as an error.
        if (!res.ok || (res.headers.get('content-type') || '').includes('text/html')) throw new Error(`cannot load /g1/${rel}`);
        return new Uint8Array(await res.arrayBuffer());
      },
      (done, total, b) => { status.textContent = `loading model: ${done} of ${total} mesh files, ${(b / 1e6).toFixed(0)} MB`; },
    );
    const built = robotView.build(mujoco, model);
    robot = new RobotLoop(mujoco, model, { holdPelvis: $('robot-hold').checked });
    realizer = new TurnRealizer(keyPoses(mujoco, model, robot.retargeter.ix, robot.standJoints));
    g1Kinesics = new G1Kinesics(mujoco, model, robot.retargeter.ix, robot.standJoints, PROFILES, g1Mapping, { setting: pageParams.get('setting') || 'video_call' });
    window.__kinesics.g1 = g1Kinesics;
    window.__kinesics.attachG1 = () => { robot.cues = g1Kinesics; };   // console only: drive the robot without a bot
    robotView.update(robot.sim.d);
    $('robot-reset').disabled = false;
    status.textContent = '';
    log(`robot view ready in ${((performance.now() - t0) / 1000).toFixed(1)} s: MuJoCo ${mujoco.mj_versionString()}, `
      + `${(bytes / 1e6).toFixed(0)} MB of meshes, ${built.parts} parts, ${built.triangles} triangles`);
    window.__robot = robot; window.__realizer = realizer; // for inspection from the console
  } catch (e) {
    status.textContent = 'unavailable';
    log('robot view unavailable:', e.message || String(e), '(run web/scripts/fetch_g1.sh, then restart the dev server)');
  }
})());

// ---------------------------------------------------------------- embodiments
// One pose stream, several bodies that can show it.  Each ticked body gets its own pane, side
// by side; a body that is not ticked is neither drawn nor simulated.  The choice is kept for
// the next visit; ?body=robot,avatar in the page address overrides it.  Default: the robot.
const PANES = { robot: 'robot-view', avatar: 'view' };
const shown = { robot: true, avatar: false };
function setBodies(names) {
  const wasRobot = shown.robot;
  for (const b of Object.keys(shown)) {
    shown[b] = names.includes(b);
    $(`body-${b}`).checked = shown[b];
    $(PANES[b]).hidden = !shown[b];
    document.body.classList.toggle(`show-${b}`, shown[b]);
  }
  try { localStorage.setItem('kinesics.bodies', bodiesText()); } catch { /* private window: not kept */ }
  avatar.resize(); robotView.resize(); // the panes changed size, and a hidden pane had none
  if (shown.robot && !wasRobot) {
    ensureRobot();
    robot?.reset(); // it starts again from standing and eases into the stream
  }
}
const bodiesText = () => Object.keys(shown).filter((b) => shown[b]).join(',');
for (const b of Object.keys(shown)) {
  $(`body-${b}`).addEventListener('change', () => {
    setBodies(Object.keys(shown).filter((x) => $(`body-${x}`).checked));
    log(`embodiments shown: ${bodiesText() || 'none'}`);
  });
}
{
  let stored = null;
  try { stored = localStorage.getItem('kinesics.bodies'); } catch { /* private window */ }
  shown.robot = false; // so that the first setBodies loads the robot if it is chosen
  setBodies((new URLSearchParams(location.search).get('body') ?? stored ?? 'robot').split(','));
}

// ---------------------------------------------------------------- state
const ring = new MotionRing();
const clock = new PlayoutClock();
const probe = new SyncProbe();
let delay = null;
let pc = null; // RTCPeerConnection, captured for getStats()
const rate = { msgs: 0, bytes: 0, t0: performance.now(), msgsPerS: 0, bytesPerS: 0 };
let serverStats = null;
let lastFlags = { speaking: false, interrupted: false };
let ping = { t0: NaN, audioMs: NaN, motionMs: NaN, armed: false, audioSeen: false, motionSeen: false };
let autoTrim = true;

// ---------------------------------------------------------------- turn cues on the robot
// A bot that sends no poses but turn cue messages (the cascaded bot) drives the robot through the
// realizer (src/robot/turn-realizer.js).  ?cues=audio in the page address ignores the messages and
// drives it from the sound heard instead, the baseline without the protocol; ?cues=off leaves it standing.
const cueMode = new URLSearchParams(location.search).get('cues') || 'on';
// The sound lag (how much later the bot's sound is heard here than its cue message says) is measured in
// each session; it starts from the value measured last time on this browser, if there is one.
const LAG_KEY = 'kinesics.cueLagMs';
const storedLag = (() => { try { const v = parseFloat(localStorage.getItem(LAG_KEY)); return Number.isFinite(v) && v >= 0 && v <= 600 ? v : undefined; } catch { return undefined; } })();
const cues = new CueTracker({ lagMs: storedLag });
let lastMove = null;
// What comes after the decoded audio, where the page hears the sound: the loudspeaker path as Chrome
// reports it, plus the trim slider as a manual adjustment (positive: the robot moves later).
const cueExtra = () => (delay && Number.isFinite(delay.playoutMs) ? delay.playoutMs : 0) + clock.trimMs;
// The realizer drives the robot only while the bot sends no poses and is one that speaks in turns.
const robotDemo = new URLSearchParams(location.search).get('robot') === 'demo';
const cueDriven = () => cueMode !== 'off' && (cues.messages > 0 || serverStats?.engine === 'cascade');
function attachRealizer() {
  if (!robot || !realizer) return;
  const want = cueDriven() ? (robotDemo || cueMode === 'audio' ? realizer : g1Kinesics) : null;
  if (robot.cues !== want) { robot.cues = want; log(want ? `robot driven by turn cues (${cueMode === 'audio' ? 'audio fallback only' : 'the bot\'s messages'})` : 'robot no longer driven by turn cues'); }
}

// Capture the peer connection the transport creates (it also exposes it as `pc`).
const RealPC = window.RTCPeerConnection;
window.RTCPeerConnection = function (...args) { const inst = new RealPC(...args); pc = inst; return inst; };
window.RTCPeerConnection.prototype = RealPC.prototype;

// ---------------------------------------------------------------- microphone
// Test hook: with ?mic=<address of a sound file> in the page address, the file plays in place
// of the microphone.  It lets a live session be checked end to end with nobody speaking, and
// in browsers that have no microphone.  Without it the real microphone is used.
const micFile = new URLSearchParams(location.search).get('mic');
// The browser's own getUserMedia, kept for the acoustic check, which needs the real microphone
// even when a sound file stands in for it on the way to the bot.
const browserGetUserMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
// ?acoustic=1: measure through the air how late the bot's audio is heard (src/acoustic.js).
const acoustic = new URLSearchParams(location.search).get('acoustic') === '1' ? new AcousticCheck(log) : null;
if (micFile) {
  let dest = null;
  const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (!constraints?.audio) return realGetUserMedia(constraints);
    if (!dest) {
      const ctx = new AudioContext();
      ctx.resume(); // a context made without a click starts paused and would send silence
      const res = await fetch(micFile);
      if (!res.ok || (res.headers.get('content-type') || '').includes('text/html')) throw new Error(`cannot load ${micFile}`);
      const source = ctx.createBufferSource();
      source.buffer = await ctx.decodeAudioData(await res.arrayBuffer());
      dest = ctx.createMediaStreamDestination();
      source.connect(dest);
      source.start();
      log(`microphone replaced by ${micFile}, ${source.buffer.duration.toFixed(1)} s, playing from now`);
    }
    return dest.stream.clone();
  };
  const realEnumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
  navigator.mediaDevices.enumerateDevices = async () => [
    ...(await realEnumerate()).filter((d) => d.kind !== 'audioinput'),
    { deviceId: 'default', groupId: 'file', kind: 'audioinput', label: `file ${micFile}`, toJSON() { return { ...this }; } },
  ];
}

function setMicState(text, cls = '') { $('mic-state').textContent = text; $('mic-state').className = 'pill ' + cls; }

// Ask for the microphone ourselves before connecting, so that a refusal is shown in plain
// words.  The Pipecat client would otherwise connect without one and say nothing.
async function askForMic() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setMicState('unavailable', 'error');
    $('mic-help').textContent = 'This page cannot reach a microphone here. Open it as http://localhost:5173 in Chrome or Safari.';
    return false;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const label = micFile ? `file ${micFile}` : stream.getAudioTracks()[0]?.label || 'microphone';
    stream.getTracks().forEach((t) => t.stop());
    setMicState(`on: ${label}`, 'ready');
    $('mic-help').textContent = 'Speak: the bar should move, and "microphone level the model hears" below should rise.';
    return true;
  } catch (e) {
    const blocked = e.name === 'NotAllowedError' || e.name === 'SecurityError';
    setMicState(blocked ? 'blocked' : e.name === 'NotFoundError' ? 'none found' : 'failed', 'error');
    $('mic-help').textContent = blocked
      ? 'The browser refused the microphone, so the model hears silence. Allow it with the icon in the address bar, then reconnect. The browser pane inside the Claude app always refuses: open this page in Chrome or Safari.'
      : `Microphone error: ${e.message || e.name}. The model hears silence.`;
    log('microphone:', e.name, e.message || '');
    return false;
  }
}

// The level of the microphone track that is actually sent, measured in this page.
const micMeter = { track: null, ctx: null, source: null, analyser: null, buf: null, shown: -100 };
function watchMicTrack() {
  const track = client.tracks()?.local?.audio || null;
  if (track === micMeter.track) return;
  micMeter.track = track;
  micMeter.analyser = null;
  if (!track) return;
  micMeter.ctx ||= new AudioContext();
  micMeter.ctx.resume();
  micMeter.analyser = micMeter.ctx.createAnalyser();
  micMeter.analyser.fftSize = 1024;
  micMeter.buf = new Float32Array(micMeter.analyser.fftSize);
  // Keep the source node referenced (browsers may otherwise discard it), and pull the graph
  // through a silent output so the analyser is always fed.
  micMeter.source?.disconnect();
  micMeter.source = micMeter.ctx.createMediaStreamSource(new MediaStream([track]));
  micMeter.source.connect(micMeter.analyser);
  const silent = micMeter.ctx.createGain();
  silent.gain.value = 0;
  micMeter.analyser.connect(silent).connect(micMeter.ctx.destination);
}
function micLevel() {
  if (!micMeter.analyser) return 0;
  micMeter.analyser.getFloatTimeDomainData(micMeter.buf);
  let sum = 0;
  for (const x of micMeter.buf) sum += x * x;
  return Math.sqrt(sum / micMeter.buf.length);
}
// Root mean square level (0 to 1) as decibels below full scale, the usual unit for audio level.
const toDb = (rms) => (rms > 1e-5 ? 20 * Math.log10(rms) : -100);

// ---------------------------------------------------------------- client
// __ICE_SERVERS__ and __BOT_URL__ are filled in by vite.config.js: empty and local for a bot on
// this machine, a public STUN server when the bot runs in the cloud.
const transport = new SmallWebRTCTransport({ iceServers: __ICE_SERVERS__ });
log(`bot: ${__BOT_URL__}`);
const client = new PipecatClient({
  transport,
  enableMic: true,
  enableCam: false,
  callbacks: {
    onTransportStateChanged: (s) => { $('state').textContent = s; $('state').className = 'pill ' + (s === 'ready' ? 'ready' : s === 'error' ? 'error' : ''); },
    onConnected: () => log('connected'),
    onDisconnected: () => { log('disconnected'); onDisconnected(); },
    onBotReady: () => { log('bot ready'); $('ping').disabled = false; report.botReady = true; report.n = 0; report.arrivals.length = 0; },
    onError: (m) => log('error', m),
    onTrackStarted: (track, participant) => {
      if (track.kind === 'audio' && !participant?.local) {
        // Nothing in the Pipecat client plays remote audio for us.  Without an
        // <audio> sink the agent is silent, and Chrome also feeds silence to
        // the WebAudio analyser the sync probe reads.
        const el = $('bot-audio');
        el.srcObject = new MediaStream([track]);
        el.play().catch((e) => log('audio autoplay blocked:', e.message));
        probe.attachTrack(track);
        acoustic?.attachBot(track);
        log('bot audio track attached to speaker and sync probe');
      }
    },
    // Standard RTVI messages about the bot's and the user's turns.  Their arrival times go to
    // the recorder (the census below); the first one is also shown in the log.
    onBotStartedSpeaking: () => { log('bot started speaking (transport)'); census.mark('bot-started-speaking'); },
    onBotStoppedSpeaking: () => census.mark('bot-stopped-speaking'),
    onBotLlmStarted: () => census.mark('bot-llm-started'),
    onBotLlmStopped: () => census.mark('bot-llm-stopped'),
    onBotTtsStarted: () => census.mark('bot-tts-started'),
    onBotTtsStopped: () => census.mark('bot-tts-stopped'),
    onUserStartedSpeaking: () => census.mark('user-started-speaking'),
    onUserStoppedSpeaking: () => census.mark('user-stopped-speaking'),
    onServerMessage: (data) => onServerMessage(data),
  },
});

// ---------------------------------------------------------------- census of turn timing
// When each standard turn message arrived here, and when the agent's audio became audible here
// and fell silent again, all on this page's clock.  Sent to the recorder with the next report.
// "Audible" is the level of the incoming audio track after the browser's jitter buffer, read
// once per drawn frame; the loudspeaker's own delay comes after it and is not included.
const HEARD_ON = 0.01, HEARD_OFF = 0.005, HEARD_QUIET_MS = 200;
const census = {
  events: [], heard: false, lastLoudMs: 0,
  cues: [], cueSeen: false,
  mark(name, t = performance.now()) { this.events.push([name, Math.round(t * 10) / 10]); },
  cue(m, t = performance.now()) {
    if (!this.cueSeen) { this.cueSeen = true; log('turn cues arriving from the bot'); }
    this.cues.push([Math.round(t * 10) / 10, m.turn, m.rev, m.status, m.onset_ms, m.onset_exact, m.end_ms, m.now_ms, m.text_started, m.segments?.length ?? 0]);
  },
  sample(now, level) {
    if (level > HEARD_ON) { if (!this.heard) { this.heard = true; this.mark('heard-on', now); this.onHeard?.('on', now); } this.lastLoudMs = now; }
    else if (level > HEARD_OFF) { if (this.heard) this.lastLoudMs = now; }
    else if (this.heard && now - this.lastLoudMs > HEARD_QUIET_MS) { this.heard = false; this.mark('heard-off', this.lastLoudMs); this.onHeard?.('off', this.lastLoudMs); }
  },
};

// Each start and stop of the bot's sound heard here is one measurement of the sound lag (src/turn-cues.js).
// Only while the page draws at full rate: a hidden or busy tab detects sound late, and would measure a wrong lag.
let frameGapMs = Infinity;
census.onHeard = (kind, t) => {
  if (cueMode === 'off' || frameGapMs >= 40 || cues.heard(kind, t) === null || !cues.lagLearned) return;
  cues.startLagMs = cues.lagMs;   // a reconnect starts from it, and so does the next visit
  try { localStorage.setItem(LAG_KEY, cues.lagMs.toFixed(1)); } catch { /* private window: not kept */ }
};

// ---------------------------------------------------------------- report to the recorder
// Once per second the page tells the server what it saw, so that a recorded session holds
// both ends: when each pose message arrived here, the browser's own network statistics for
// the connection, and the readings shown in the panel.  The server writes it to client.jsonl
// (the recorder of the earlier pose-stream prototype, not in this repository).  About 3 kilobytes per second on the data channel.
const report = { arrivals: [], frames: 0, t0: performance.now(), n: 0, botReady: false };
const RTC_FIELDS = {
  'inbound-rtp': ['kind', 'packetsReceived', 'packetsLost', 'packetsDiscarded', 'bytesReceived', 'jitter',
    'jitterBufferDelay', 'jitterBufferTargetDelay', 'jitterBufferMinimumDelay', 'jitterBufferEmittedCount',
    'totalSamplesReceived', 'concealedSamples', 'silentConcealedSamples', 'concealmentEvents',
    'insertedSamplesForDeceleration', 'removedSamplesForAcceleration', 'totalProcessingDelay',
    'lastPacketReceivedTimestamp', 'estimatedPlayoutTimestamp'],
  'outbound-rtp': ['kind', 'packetsSent', 'bytesSent', 'retransmittedPacketsSent', 'nackCount', 'targetBitrate'],
  'remote-inbound-rtp': ['kind', 'packetsLost', 'fractionLost', 'jitter', 'roundTripTime', 'totalRoundTripTime', 'roundTripTimeMeasurements'],
  'candidate-pair': ['state', 'nominated', 'currentRoundTripTime', 'totalRoundTripTime', 'responsesReceived',
    'bytesSent', 'bytesReceived', 'availableOutgoingBitrate', 'packetsSent', 'packetsReceived'],
  'data-channel': ['label', 'state', 'messagesSent', 'messagesReceived', 'bytesSent', 'bytesReceived'],
  'media-playout': ['totalPlayoutDelay', 'totalSamplesCount', 'totalSamplesDuration', 'synthesizedSamplesDuration', 'synthesizedSamplesEvents'],
};
async function rtcStats() {
  const conn = transport.pc || pc;
  if (!conn) return null;
  const all = await conn.getStats();
  const out = {};
  let selectedPair = null; // the one path the connection actually uses
  all.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) selectedPair = s.selectedCandidatePairId; });
  all.forEach((s) => {
    const fields = RTC_FIELDS[s.type];
    if (!fields) return;
    if (s.type === 'candidate-pair' && (selectedPair ? s.id !== selectedPair : !(s.nominated && s.state === 'succeeded'))) return;
    const row = { stats_ms: s.timestamp };
    for (const f of fields) if (s[f] !== undefined) row[f] = s[f];
    if (s.type === 'candidate-pair') {
      // How the two ends reach each other (direct or relayed, UDP or TCP), without their addresses.
      const local = all.get(s.localCandidateId), remote = all.get(s.remoteCandidateId);
      row.local = local && `${local.candidateType}/${local.protocol}`;
      row.remote = remote && `${remote.candidateType}/${remote.protocol}`;
    }
    (out[s.type] ||= []).push(row);
  });
  return out;
}
async function sendReport(now) {
  if (!report.botReady || transport.state !== 'ready') { report.arrivals.length = 0; return; }
  const playhead = clock.playhead(now);
  const data = {
    v: 1, n: report.n++,
    perf_ms: now, epoch_ms: Date.now(),   // this page's clock at the moment of sending, both ways
    visible: document.visibilityState === 'visible',
    fps: report.frames / Math.max((now - report.t0) / 1000, 1e-3),
    arrivals: report.arrivals.splice(0),  // [seq, pts_ms, arrival time on this page's clock]
    census: census.events.splice(0),      // [name, time on this page's clock]: turn messages and audible audio
    cues: census.cues.splice(0),          // [arrival on this page's clock, turn, rev, status, onset_ms, onset_exact, end_ms, now_ms, text_started, segments]
    // The robot's movements started from turn cues (src/robot/turn-realizer.js), and the clock relation they used.
    turn_cue_robot: { mode: cueMode, driven: !!robot?.cues, offsetMs: cues.offsetMs,
      lagMs: cues.lagMs, lagLearned: cues.lagLearned, lagSamples: cues.lagSamples.length, extraMs: cueExtra(),
      addedMs: cues.lagMs + cueExtra(),   // everything added to arrival plus lead
      moves: realizer ? realizer.take() : [] },
    // Movements started by the kinesics realizer (src/kinesics/), per body, and the profile setting in use.
    kinesics: { setting: kinesics.setting, vrmMapping: vrmMapping.name, g1Mapping: g1Mapping.name, avatar: shown.avatar ? kinesics.take() : (kinesics.take(), []), g1: shown.robot && g1Kinesics ? g1Kinesics.take() : (g1Kinesics?.take(), []) },
    // The acoustic check (?acoustic=1): [{t, lagMs, corr}] since the last report, and the page's own audio output latency.
    acoustic: acoustic ? { results: acoustic.take(), baseLatencyMs: acoustic.ctx ? acoustic.ctx.baseLatency * 1000 : null, outputLatencyMs: acoustic.ctx ? acoustic.ctx.outputLatency * 1000 : null } : null,
    clock: { offsetMs: clock.offsetMs, jitterMs: clock.jitterMs, autoTrimMs: clock.autoTrimMs, trimMs: clock.trimMs, audioDelayMs: clock.audioDelayMs, playheadMs: playhead },
    delay: delay && { jitterMs: delay.jitterMs, rttMs: delay.rttMs, playoutMs: delay.playoutMs, totalMs: delay.totalMs },
    ring: { aheadMs: Number.isFinite(playhead) ? ring.newestPts - playhead : null, frames: ring.frames.length, late: ring.late, starved: ring.starved },
    sync: { lagMs: probe.lagMs, corr: probe.corr },
    mic: { levelDb: toDb(micLevel()), enabled: client.isMicEnabled, file: micFile },
    embodiments: bodiesText(),
    robot: (shown.robot ? robot?.stats() : null) ?? null,
    rtc: await rtcStats().catch(() => null),
  };
  report.frames = 0; report.t0 = now;
  // JSON has no NaN or Infinity: send null instead.
  try { client.sendClientMessage('client_stats', JSON.parse(JSON.stringify(data, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v)))); }
  catch (e) { log('report not sent:', e.message || e); }
}

function onServerMessage(data) {
  if (!data || typeof data !== 'object') return;
  if (data.t === 'motion') {
    const now = performance.now();
    report.arrivals.push([data.seq, data.pts_ms, Math.round(now * 10) / 10]);
    rate.msgs++; rate.bytes += JSON.stringify(data).length;
    clock.observe(data.pts_ms, now);
    const playhead = clock.playhead(now);
    for (const f of decodeMotion(data)) { ring.push(f, playhead); if (shown.robot) robot?.push(f, playhead); }
    lastFlags = data.flags || lastFlags;
    if (ping.armed && !ping.motionSeen && data.flags?.speaking) { ping.motionSeen = true; ping.motionMs = now - ping.t0; }
  } else if (data.t === 'stats') {
    serverStats = data;
  } else if (data.type === 'bot-turn-cue') {
    // Turn cues (turn-cue-protocol.md): recorded for the census, and acted on by the robot.
    const now = performance.now();
    census.cue(data, now);
    if (cues.observe(data, now) && cueMode === 'on') { realizer?.plan(cues, now, cueExtra()); kinesics.plan(cues, now, cueExtra()); g1Kinesics?.plan(cues, now, cueExtra()); }
    attachRealizer();
  } else {
    log('server message', data);
  }
}

function onDisconnected() {
  acoustic?.stop();
  report.botReady = false; $('r-rec').textContent = '–'; $('r-engine').textContent = '–'; $('r-heard').textContent = '–';
  $('mic-mute').disabled = true; $('mic-mute').textContent = 'Mute'; micMeter.track = null; micMeter.analyser = null;
  $('ping').disabled = true; ring.clear(); robot?.ring.clear(); clock.reset(); serverStats = null; pc = null;
  cues.reset(); realizer?.reset(); attachRealizer();
}

$('connect').addEventListener('click', async () => {
  if (transport.state === 'ready' || transport.state === 'connected' || transport.state === 'connecting') {
    await client.disconnect();
    $('connect').textContent = 'Connect';
    return;
  }
  try {
    $('connect').textContent = 'Disconnect';
    ring.clear(); robot?.ring.clear(); clock.reset();
    delay = new AudioDelayEstimator(() => transport.pc || pc);
    const haveMic = await askForMic();
    if (acoustic) {
      try { await acoustic.start(browserGetUserMedia); }
      catch (e) { log('acoustic check could not open the microphone:', e.message || e.name); }
    }
    await client.connect({ webrtcRequestParams: { endpoint: `${location.origin}/api/offer` } });
    $('mic-mute').disabled = !haveMic;
  } catch (e) {
    log('connect failed:', e.message || e);
    $('connect').textContent = 'Connect';
  }
});

$('ping').addEventListener('click', () => {
  ping = { t0: performance.now(), audioMs: NaN, motionMs: NaN, armed: true, audioSeen: false, motionSeen: false };
  client.sendClientMessage('ping');
  log('ping sent');
});

$('mic-mute').addEventListener('click', () => {
  const on = !client.isMicEnabled;
  client.enableMic(on);
  $('mic-mute').textContent = on ? 'Mute' : 'Unmute';
  log(on ? 'microphone on' : 'microphone muted: the model hears silence');
});

$('trim').addEventListener('input', (e) => { clock.trimMs = +e.target.value; $('trimv').textContent = e.target.value; });
$('zup').addEventListener('change', (e) => (avatar.options.zUpFix = e.target.checked));
$('rootxz').addEventListener('change', (e) => (avatar.options.rootXZ = e.target.checked));
$('skel').addEventListener('change', (e) => (avatar.options.skeleton = e.target.checked));

// ---------------------------------------------------------------- loops
let reportTick = false; // the loop below runs twice per second; the report goes out on every second run
setInterval(async () => {
  if (delay) { await delay.update(); clock.audioDelayMs = Number.isFinite(delay.totalMs) ? delay.totalMs : 0; }
  const now = performance.now(), dt = (now - rate.t0) / 1000;
  if (dt >= 1) { rate.msgsPerS = rate.msgs / dt; rate.bytesPerS = rate.bytes / dt; rate.msgs = 0; rate.bytes = 0; rate.t0 = now; }
  watchMicTrack();
  attachRealizer();
  // Movements not started yet follow the newest audio delay.
  if (realizer && cueMode === 'on' && cues.state && cues.live(performance.now())) realizer.plan(cues, performance.now(), cueExtra());
  if ((reportTick = !reportTick)) await sendReport(performance.now());
  const r = probe.compute();
  if (r && autoTrim && r.corr > 0.5 && Math.abs(r.lagMs) >= 10) {
    // Nudge the playhead so motion lands on the audio; small steps to stay stable.
    clock.autoTrimMs += Math.sign(r.lagMs) * Math.min(Math.abs(r.lagMs), 20) * -1;
  }
  updateReadout(now);
}, 500);

let lastT = performance.now();
let lastSample = null;
function frame() {
  requestAnimationFrame(frame);
  report.frames++;
  const now = performance.now();
  frameGapMs = now - lastT;
  const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
  const playhead = clock.playhead(now);
  if (Number.isFinite(playhead)) {
    const s = ring.sample(playhead);
    if (s) { lastSample = s; if (shown.avatar) avatar.setPose(s); }
  }
  // ping -> first audible audio
  const heardLevel = probe.audioLevel();
  if (ping.armed && !ping.audioSeen && heardLevel > 0.02) { ping.audioSeen = true; ping.audioMs = now - ping.t0; }
  census.sample(now, heardLevel);
  // The audio fallback: acts only when forced, or when the bot's cue messages stop coming.
  if (realizer && robot?.cues === realizer) realizer.audio(now, heardLevel > (realizer.heard ? HEARD_OFF : HEARD_ON), cueMode === 'audio' || !cues.live(now));
  probe.sample(now, lastSample ? jawAngle(lastSample) : 0);
  // Microphone bar: -60 decibels (quiet room) to 0 (full scale) across its width.
  // It jumps up at once and falls slowly (about 30 decibels per second), so short words stay visible.
  micMeter.shown = Math.max(toDb(micLevel()), micMeter.shown - 30 * dt);
  $('mic-bar').style.width = `${Math.max(0, Math.min(100, (micMeter.shown + 60) / 60 * 100))}%`;
  // Turn cues on the avatar: only while the bot is one that speaks in turns and sends no poses.
  // Before any pose arrives the avatar also rests this way, with its arms down.
  if (shown.avatar && vrmKinesics && !lastSample) {
    // The mouth is a placeholder, not a turn cue: opened by the loudness of the bot's audio.
    const open = Math.min(1, heardLevel / 0.08);
    mouthShown += (open - mouthShown) * Math.min(1, dt * (open > mouthShown ? 30 : 12));
    avatar.setKinesics(vrmKinesics, kinesics.sample(now), mouthShown);
  }
  if (shown.avatar) avatar.render(dt);
  if (shown.robot) {
    // The robot runs its control ticks on the same playhead as the avatar, so every body follows the speech.
    if (robot) { robot.advance(now, playhead); robotView.update(robot.sim.d); }
    robotView.render();
  }
}
frame();

function updateReadout(now) {
  if (delay) {
    $('r-jb').textContent = fmt(delay.jitterMs) + ' ms';
    $('r-rtt').textContent = fmt(delay.rttMs / 2, 1) + ' ms (RTT ' + fmt(delay.rttMs, 1) + ')';
    $('r-po').textContent = fmt(delay.playoutMs) + ' ms';
    $('r-total').textContent = fmt(delay.totalMs) + ' ms';
  }
  $('r-rate').textContent = `${fmt(rate.msgsPerS, 1)} · ${fmt(rate.bytesPerS)} B/s`;
  $('r-off').textContent = `${fmt(clock.offsetMs)} · ${fmt(clock.jitterMs)} ms  (auto-trim ${fmt(clock.autoTrimMs)} ms)`;
  const playhead = clock.playhead(now);
  $('r-ahead').textContent = Number.isFinite(playhead) && Number.isFinite(ring.newestPts) ? `${fmt(ring.newestPts - playhead)} ms (${ring.frames.length} frames)` : '–';
  $('r-late').textContent = `${ring.late} · ${ring.starved}`;
  $('r-flags').textContent = `speaking=${lastFlags.speaking} interrupted=${lastFlags.interrupted}`;
  $('r-lag').textContent = Number.isFinite(probe.lagMs) ? `${probe.lagMs > 0 ? '+' : ''}${fmt(probe.lagMs)} ms (motion ${probe.lagMs > 0 ? 'late' : 'early'}, r=${fmt(probe.corr, 2)})` : '– (needs speech)';
  $('r-e2e').textContent = Number.isFinite(ping.audioMs) ? `${fmt(ping.audioMs)} ms (incl. ~90 ms scripted onset)` : '–';
  $('r-e2em').textContent = Number.isFinite(ping.motionMs) ? `${fmt(ping.motionMs)} ms` : '–';
  const rs = shown.robot ? robot?.stats() : null;
  if (rs) {
    $('r-rticks').textContent = `${fmt(rs.posedPct)}% · ${rs.dropped}`;
    $('r-rcpu').textContent = `${fmt(rs.tickMs, 2)} ms (max ${fmt(rs.tickMsMax, 1)}) · ${fmt(rs.retargetMs, 2)} ms, ${fmt(rs.iterations, 1)} iterations`;
    $('r-rerr').textContent = `${fmt(rs.retargetErrDeg, 1)}°`;
    $('r-rtrack').textContent = `${fmt(rs.armRmsDeg, 1)}°`;
    $('r-rsat').textContent = `${fmt(rs.saturatedPct)}%`;
    $('r-rlim').textContent = rs.engaging ? 'easing in' : `${fmt(rs.limitedPct)}% · ${fmt(rs.limitedDeg, 1)}°`;
    $('r-rbal').textContent = `${fmt(rs.tiltDeg, 1)}° · ${fmt(rs.pelvisHeight, 2)} m`;
  }
  if (shown.robot) {
    $('r-cmode').textContent = !robot?.cues ? (cueMode === 'off' ? 'off' : 'not driven (no turn cues)') : realizer.source === 'audio' ? 'audio fallback' : 'cue messages';
    $('r-cclock').textContent = `${fmt(cues.lagMs)} ms (${cues.lagLearned ? 'measured' : storedLag === undefined ? 'starting value' : 'from last time'}) · ${fmt(cueExtra())} ms`;
    $('r-cstate').textContent = cues.state ? `${cues.state.turn} · ${cues.state.status}` : '–';
    const m = realizer?.moves.at(-1) ?? lastMove;
    if (m) {
      lastMove = m;
      $('r-cmove').textContent = `${m.kind} · ${fmt(m.startMs - m.wantedMs)} ms · ${m.bodyLagMs === null ? '–' : fmt(m.bodyLagMs) + ' ms'}`;
    }
  }
  if (serverStats) {
    const a = serverStats.avg || {}, m = serverStats.max || {};
    $('r-engine').textContent = { synthetic: 'scripted stand-in (no model)', miburi: 'full-duplex speech model with a gesture model', cascade: 'cascaded bot: speech recognition, language model, speech synthesis' }[serverStats.engine] || serverStats.engine || '–';
    $('r-rec').textContent = serverStats.recording ? 'ON: audio, poses and timing are saved' : 'off';
    const heard = toDb(a.mic_level ?? 0);
    $('r-heard').textContent = a.mic_level === undefined ? '–' : heard < -70 ? 'silence' : `${fmt(heard)} dB${heard > -45 ? ' (speech)' : ' (quiet)'}`;
    $('r-srv').textContent = `${fmt(a.speech_ms, 2)} / ${fmt(a.motion_ms, 2)} / ${fmt(a.step_ms, 2)} (max ${fmt(m.step_ms, 1)})`;
    $('r-srv2').textContent = `${serverStats.queue} · ${serverStats.motion_queue ?? 0} · ${serverStats.dropped} · ${serverStats.bytes_per_s} B/s`;
  }
}
