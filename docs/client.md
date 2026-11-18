# The client

*Reference for the code in `web/src/`: how a client receives turn cues and turns them into body
movement. The message itself is specified in `turn-cue-protocol.md`; where the movement numbers
come from is in `kinesics-profiles.md`. The client here is a browser page, but only section 6 is
about browsers: the tracker, the realizer and the mapping have no browser dependency.*

**Terms used here.**
- **Turn cue**: one `bot-turn-cue` message, the whole state of the bot's current speaking turn.
- **Local time**: the client's own clock in milliseconds (`performance.now()` in a browser).
- **Heard time**: the local time at which this client hears a sound the bot announced.
- **Sound lag**: how much later this client hears a sound than the message's arrival plus its lead
  says. Each client has its own.
- **Channel**: one body-neutral quantity the realizer moves, such as "how far the eyes are from
  the partner".
- **Mapping**: a table that says which joint or bone shows which channel on one body.
- **VRM**: a file format for 3D avatars. **G1**: Unitree's humanoid robot, simulated here.

---

## 1. Overview

```
bot-turn-cue message
      |
      v
CueTracker            turn-cues.js             which state is current; bot time -> heard time
      |
      v
KinesicsRealizer      kinesics/kinesics-realizer.js   state + profile -> channels over time
      |   sample(t)
      v
mapping table         kinesics/mappings.json, mapping.js    channels -> joint or bone angles
      |
      v
VrmKinesics           kinesics/vrm-adapter.js   sets the avatar's bones, eyes and blink
G1Kinesics            kinesics/g1-adapter.js    29 joint targets for the robot
```

Three steps, each replaceable: the tracker knows about messages and time, the realizer knows about
movement, the mapping knows about one body. The bot knows none of this.

---

## 2. `CueTracker` (`turn-cues.js`)

Keeps the newest state of the bot's turn and converts the bot's times to heard times. The method is
the one in `turn-cue-protocol.md`, section 5: it never compares clocks, and uses each announced time
only as a lead over the message that carried it.

`new CueTracker({ lagMs = 130, learnLag = true })`

- `lagMs`: the starting sound lag in milliseconds. The page passes the lag it learned in its last
  session.
- `learnLag`: `false` for a client that knows its own lag, such as a robot that plays the audio it
  receives.

| Member | Meaning |
|---|---|
| `observe(message, arrival)` | Give it every `bot-turn-cue` message with the local time it arrived. Returns `true` if it carried a new state, `false` for a repeat, an out-of-date state or an unknown version. `(turn, rev)` decides which state is current, not arrival order |
| `state` | The newest message for the newest turn, or `null` |
| `heardAt(serverMs, extraMs = 0)` | The local time at which a sound that leaves the server at `serverMs` is heard here; `NaN` if not known yet. `extraMs` is whatever this client adds after the point where it detects sound (for a browser: the loudspeaker path) |
| `heard(kind, t)` | Tell it that the bot's sound was heard to start (`'on'`) or stop (`'off'`) at local time `t`. If an announced segment boundary is within 250 ms of where the present lag puts it, this is one measurement of the lag. Returns the lag measured, or `null` |
| `lagMs` | The sound lag in use: the median of the last 9 measurements once there are 3; until then the starting value |
| `lagLearned` | Whether the lag in use was measured in this session |
| `clockReady` | Whether heard times can be trusted to within a few tens of milliseconds |
| `offsetMs` | The smallest `arrival − now_ms` over the last 10 seconds of messages |
| `textAt` | For each turn, the arrival of its first message with `text_started` |
| `live(now, quietMs = 3000)` | Whether messages are still coming |
| `reset()` | Forget everything except the starting lag |

A minimal client:

```js
import { CueTracker } from './turn-cues.js';
const cues = new CueTracker();

// with the Pipecat client: onServerMessage: (data) => { ... }
function onServerMessage(data) {
  if (data?.type !== 'bot-turn-cue') return;
  const now = performance.now();
  if (cues.observe(data, now)) realizer.plan(cues, now);   // a new state: plan movements for it
}
```

---

## 3. `KinesicsRealizer` (`kinesics/kinesics-realizer.js`)

Turns the state of the turn into movement of seven channels, timed against heard time. It is
body-neutral: its output is angles in degrees and shares between 0 and 1, and it has no dependency
on a browser, an avatar or a robot.

`new KinesicsRealizer(profiles, options)`

| Option | Default | Meaning |
|---|---|---|
| `setting` | `'video_call'` | Which profile of `profiles.json` to use: `'video_call'` or `'same_room'` |
| `side` | `1` | `+1` or `−1`: the side the body looks away to |
| `liveliness` | `true` | `false` switches off the small continuous head motion |
| `livelinessScale` | `1` | Makes that motion smaller and slower by this factor |
| `headReturnsWithEyes` | `false` | At the end of a turn, the head returns on the eyes' timing. For a body whose head or torso is its only way to show gaze |
| `seed` | `1` | Fixes the timing of glances and blinks, so a run can be repeated |

| Method | Meaning |
|---|---|
| `plan(tracker, now, extraMs = 0)` | Call on every new state. Plans the movements this state implies. Safe to call repeatedly: a movement already started is not started again |
| `sample(t)` | Call once per frame or control tick. Starts the movements that are due and returns the channels at local time `t` |
| `take()` | The movements started since the last call, for a timing report |
| `reset()` | Back to listening, nothing planned |

**What `sample(t)` returns.**

| Field | Unit | Meaning |
|---|---|---|
| `headYawDeg` | degrees | The head's turn away from the partner, signed by `side`, including the small continuous motion |
| `headPitchDeg` | degrees, chin up positive | The head's pitch, including the small continuous motion |
| `eyeYawDeg` | degrees | The eyes' own turn in the head, on top of the head's |
| `eyePitchDeg` | degrees | Always 0 at present |
| `blink` | 0 (open) to 1 (closed) | |
| `hand` | 0 (at rest) to 1 (raised) | |
| `handTl` | torso lengths | The same as a height above rest |
| `torsoLeanDeg` | degrees, towards the partner positive | |
| `mouth` | 0 (closed) to 1 (the usual opening while speaking) | The mouth's resting posture, under the lip movement. 0.5 is "half open" |
| `speedDps` | degrees per second | How lively the head is at this moment |
| `gaze` | `{ eyes, head }`, each 0 (on the partner) to 1 (away) | |
| `liveYawDeg`, `livePitchDeg` | degrees | The small continuous motion's own part of the two head angles, so a mapping can scale it separately |

**What it does over a turn** (times for the `video_call` profile, against the sound as heard):

| Phase | Movement |
|---|---|
| Listening | Faces the partner; the head drifts slowly; blinks |
| Before the bid | The mouth opens a quarter as soon as the bot's state is `preparing`, before the reply's first text, and holds. Nothing else moves yet |
| Bid (about to speak) | The mouth is half open 430 ms before the first sound (100 ms before a short reply). Eyes leave the partner from 700 ms before the first sound; the head starts 500 ms before and is away by 300 ms after; a small head dip; the hand rises to 700 ms after the first sound |
| Speaking | Head and eyes away, with glances back at the partner (eyes only, 800 ms each) for the measured share of the time |
| Pause inside the reply | The mouth stays half open for the first second, then closes, and opens again just before the sound resumes. Keeps looking away; the head slows from 700 ms before the pause and the chin rises a little; the hand stays up |
| Yield (finishing) | The mouth closes by 250 ms after the last sound. The hand starts down 1,000 ms before the last sound; the eyes are back 100 ms before it; the head follows by 700 ms after and settles by 1,000 ms after |
| Cancelled, interrupted | Everything returns to listening at once, over 500 ms or 400 ms |

A reply known to be shorter than 1,600 ms keeps facing the partner and keeps the hand down.

**Rules it follows.**
- **Nothing but the mouth before the text.** Head, eyes and hand wait for `text_started`, so a reply
  dropped before its first text shows only a mouth that opened a little and closed again. The mouth
  starts earlier because it needs about a second of run-up (profile value `ready_on_preparing`).
- **Late cues.** When a state arrives too late for a movement's planned start, the movement starts
  at once and runs faster, down to two thirds of its normal duration. With less time than that it
  finishes late.
- **Smooth curves.** Every channel moves on a minimum-jerk curve from wherever it is, so a new
  movement never causes a jump.
- **Not done yet:** a bid that started on the estimated first sound is not re-timed when the exact
  time arrives. It therefore tends to run early by the size of the estimate's error.

---

## 4. Mappings (`kinesics/mappings.json`, `kinesics/mapping.js`)

A mapping says, for one body, which joint or bone shows what. It belongs to the client: the bot
does not send it and does not know it. Showing a cue differently is a change to the table, not to
code.

Each target is the body's rest value plus the sum of *gain × source*:

```json
"waist_pitch_joint": { "head_pitch": -1.0, "head_away": 0.4, "eye_away": 0.4 }
```

| Source | Unit | From `sample(t)` |
|---|---|---|
| `head_away`, `eye_away` | degrees, unsigned | How far the head and the eyes are from the partner |
| `head_away_sided`, `eye_away_sided` | degrees, signed | The same, signed to the side the body looks away to |
| `head_pitch` | degrees, chin up positive | Without the small continuous motion |
| `live_yaw`, `live_pitch` | degrees | The small continuous motion |
| `torso_lean` | degrees | |
| `hand` | 0 to 1 | |
| `blink` | 0 to 1 | |
| `mouth` | 0 to 1 | The mouth's resting posture |
| `const` | always 1 | For a fixed pose, such as hanging arms or curled fingers |

| Function | Meaning |
|---|---|
| `sources(sample)` | The table above, from one sample |
| `applyMapping(mapping, sources, out)` | Target name → value. An unknown source name is an error |
| `pickMapping(mappings, body, name)` | The mapping called `name` for `'g1'` or `'vrm'`, or that body's default |

Mappings that exist:

| Body | Mapping | What it does |
|---|---|---|
| G1 | `forward` (default) | The look away is a forward bend at the waist, at 40% of the head's and eyes' angles, so the chest keeps facing the partner. One raised arm |
| G1 | `side` | The look away is a waist turn to the side, at 40% |
| Avatar | `natural` (default) | Neck 40% and head 60% of each head angle; eyes and blink at measured size; the mouth's resting posture at 0.8; arms hanging; relaxed fingers; the right forearm rises with the hand |

A mapping may also carry `head_returns_with_eyes`, which the adapters pass to the realizer.

**Adding a mapping:** add an entry under `g1` or `vrm` in `mappings.json` and select it by name. No
code changes.

---

## 5. Adapters, and adding a body

An adapter applies a mapping to one kind of body.

**`VrmKinesics(vrm, mapping)`** (`kinesics/vrm-adapter.js`). Targets are `bone.axis` of the model's
normalized humanoid bones in degrees (for example `neck.y`, `rightLowerArm.y`), plus `eyes.yaw`,
`eyes.pitch`, `blink` and `mouth` (the model's open-mouth expression). Call `apply(sample, lipMovement)` every frame; the mouth shows the larger of the mapped resting posture and the lip movement. It handles both VRM 1 and the
older VRM 0 format, whose bone axes are partly reversed.

**`G1Kinesics(mujoco, model, ix, standJoints, profiles, mapping, options)`**
(`kinesics/g1-adapter.js`). Targets are the robot model's joint names. It owns a realizer, and
`target(t)` returns the joint targets for local time `t`: the stand pose plus the mapping's values.
The robot loop sends them through a limiter to the simulated robot, 50 times per second.

**A new body needs:**

1. A list of target names the body understands (bones, joints, motor channels).
2. A mapping for it in `mappings.json`.
3. A few lines that call `applyMapping(mapping, sources(realizer.sample(t)))` each tick and write
   the values to the body.

For a body with no eyes or neck, send `head_away` and `eye_away` to a joint that people will read
as its gaze, and set `head_returns_with_eyes`.

---

## 6. The browser page (`main.js`)

The page connects to the bot with the Pipecat JavaScript client over WebRTC, shows a VRM avatar and
a simulated G1, and wires the parts above together.

- **Messages in:** `onServerMessage` passes each `bot-turn-cue` to the tracker and, on a new state,
  calls `plan` on the avatar's realizer and the G1's.
- **Sound lag:** the page watches the loudness of the bot's decoded audio. Each start and stop of
  sound is given to `tracker.heard(...)`. It does this only while the page draws at full rate, and
  keeps the learned lag in the browser's local storage for the next visit.
- **After decoding:** the loudspeaker path (Chrome's playout delay from
  `RTCPeerConnection.getStats()`, plus the page's manual trim) is passed as `extraMs`.
- **Per frame:** the avatar's realizer is sampled and applied; the G1's is sampled by the robot
  loop.
- **Messages out:** once a second the page sends an RTVI client message `client_stats` with its
  frame rate, its sound lag, when it heard sound start and stop, and every movement its realizers
  started. The bot records it and does not act on it. `server/tools/kinesics_report.py` reads it.

**Keep the page visible.** A hidden browser tab draws about once a second, and movements and
timing become unreliable.

Page options, added to the address:

| Option | Meaning |
|---|---|
| `body=avatar`, `body=robot`, `body=robot,avatar` | Which bodies to show |
| `g1map=<name>`, `vrmmap=<name>` | Which mapping each body uses |
| `setting=video_call` or `same_room` | Which profile |
| `vrm=<name>` | Load `web/public/<name>.vrm` as the avatar |
| `frame=face` | Head-and-shoulders camera on the avatar |
| `cues=on` (default), `cues=audio`, `cues=off` | Act on the bot's messages; act only on the sound heard (a baseline); or ignore cues |
| `robot=demo` | An earlier, simpler realizer for the robot (both arms, a torso turn), kept for comparison |
| `mic=<path to a .wav file>` | Use a recording in place of the microphone, for repeatable runs |
| `acoustic=1` | Measure through the microphone how long after decoding the bot is actually heard |

**Also in the page:** `wire.js`, `motion-ring.js`, `sync.js`, `joint-map.js`
and `robot/retarget.js` play a stream of full-body poses. The cascaded bot
sends no such stream.

---

## 7. Tests

`npm test` in `web/` runs 54 tests with Node's built-in test runner, no browser needed.

| File | Covers |
|---|---|
| `test/kinesics-realizer.test.mjs` | The realizer: each phase's timing against the profile, the mouth (early opening, readiness on `preparing`, pauses, short replies, dropped replies), the share of glances, late cues, short replies, interruption, and that a body whose head is its only gaze never jumps |
| `test/kinesics-mapping.test.mjs` | The mapping tables for both bodies, and that an unknown source name is refused |
| `test/turn-realizer.test.mjs` | The tracker and the earlier robot realizer |
| `test/limiter.test.mjs`, `robot-sim.test.mjs`, `robot-loop.test.mjs`, `retarget.test.mjs`, `acoustic.test.mjs` | The robot's limiter, simulation and control loop; the pose-stream code; the acoustic check |

The robot tests need the G1 model: run `web/scripts/fetch_g1.sh` first.
