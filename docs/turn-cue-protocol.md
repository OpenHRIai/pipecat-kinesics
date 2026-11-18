# Turn cue protocol, version 1

*Specification of the `bot-turn-cue` message, version 1: what a Pipecat bot tells its clients about its own turn, early enough for a body to show it. The bot-side code is described in `pipecat-modules.md` and drawn in `turn-cue-pipeline.md`. The client-side code is described in `client.md`.*

**Terms used here.**
- **Bot**: a Pipecat bot that speaks through a text-to-speech (TTS) service, such as `server/bot_cascade.py`.
- **Client**: anything connected to the bot over WebRTC that shows the bot's turn with a body: the browser page with its avatar and simulated robot, or a robot.
- **RTVI**: Pipecat's message protocol between a bot and its clients, carried on the WebRTC data channel. An RTVI server message is its slot for application data.
- **Sound leaves the server**: the moment Pipecat's output transport sends that audio to the network. Every time in the message is of this kind.
- **Bot clock**: the bot's monotonic clock, in milliseconds. Its zero is arbitrary.
- **Lead**: how long after a message was sent the sound it announces leaves the server. Negative when the sound has already left.
- **Sound lag**: how much later a client hears a sound than the message's arrival plus its lead. Each client has its own.

---

## 1. What the message is for

A body that takes part in a conversation has to move before the sound it goes with. People begin to open the mouth about 0.7 to 0.8 seconds before their first word and look back at their partner in the last 0.5 seconds before they stop (from the turn-taking study behind `kinesics-movement-measurements.md`). Pipecat's standard RTVI messages say only that something has just happened (`bot-started-speaking`, `bot-stopped-speaking`), carry no time a client can relate to what the listener hears, and say nothing about pauses inside a reply.

A bot that speaks through a TTS service knows these moments before the listener hears them, because the service produces speech faster than it is played. This message carries that knowledge to every client: when the bot's sound will start, where it will pause, and when it will end.

---

## 2. Transport

- **Carrier.** An ordinary RTVI server message (`"type": "server-message"` in the RTVI envelope). Its `data` is the object of section 4. A client reads it with the Pipecat client's `onServerMessage` callback and recognises it by `data.type === "bot-turn-cue"`.
- **Order.** Pipecat's data channel delivers in order and resends what is lost. A message can still arrive late after a lost packet. Section 5 says how a client stays correct.
- **Size.** A median of 291 bytes and at most 487 bytes in the session measured, so one message fits in one network packet.
- **Rate.**
  - **On every change** of the turn's state: a few to about 20 messages per reply.
  - **Once a second** in addition, the latest state is sent again with a new `now_ms` and the same `turn` and `rev`. This keeps the arrival reference of section 5 fresh between turns.
  - **Before the first turn**, the repeat sends an `idle` state, so a client can relate the clocks before it needs to.

---

## 3. One turn, from start to end

A **turn** is one reply of the bot: what it says between two turns of the user. Every message carries the whole state of the current turn, so a client that misses one loses nothing once the next arrives.

| `status` | Meaning | What arrives while in it |
|---|---|---|
| `idle` | No turn yet in this session | |
| `preparing` | The bot has started a reply. No sound has left yet | `text_started` becomes true at its first text; `onset_ms` appears as an estimate; `words` may appear |
| `speaking` | The reply's first sound is known exactly | `segments` grow and close; `words`; then `end_ms` |
| `ended` | The reply's last audio has been sent | Final state of the turn |
| `cancelled` | The reply was dropped before any of its sound left the server, usually because the user went on speaking | Final state of the turn |
| `interrupted` | The user spoke while the reply was playing; its remaining audio was dropped | `end_ms` is the moment of the cut. Final state of the turn |

```
idle ─▶ preparing ─▶ speaking ─▶ ended
            │            │
            ▼            ▼
        cancelled    interrupted
```

A new turn starts with `preparing` and a `turn` number one higher. Speech that does not come from the language model (a bot that speaks a fixed sentence) skips the first messages of `preparing` but follows the same states.

---

## 4. Fields

```json
{ "type": "bot-turn-cue", "v": 1, "now_ms": 6582.7,
  "turn": 3, "rev": 12, "status": "speaking",
  "text_started": true,
  "onset_ms": 6103.6, "onset_exact": true,
  "segments": [ { "start_ms": 6103.6, "end_ms": 6613.6 },
                { "start_ms": 6939.7, "end_ms": 7499.7 },
                { "start_ms": 7739.7, "end_ms": 8449.7 },
                { "start_ms": 8807.9, "end_ms": 9537.9 } ],
  "end_ms": 9537.9,
  "words": 12 }
```

Times are milliseconds on the bot clock, rounded to 0.1 ms, and all except `now_ms` mean "when that sound leaves the server".

| Field | Type | Meaning |
|---|---|---|
| `type` | string | Always `"bot-turn-cue"` |
| `v` | integer | Protocol version, 1. A client must ignore a version it does not know |
| `now_ms` | number | The bot clock at the moment this message was sent |
| `turn` | integer | Counts the bot's turns in this session, from 1. 0 before the first |
| `rev` | integer | Counts the states of this turn, from 1. A message with a lower `rev` than one already seen for the same turn is out of date. A repeat has the same `turn` and `rev` as the message it repeats |
| `status` | string | Section 3 |
| `text_started` | boolean | The bot has produced its first text for this reply. It is the earliest sign that the reply will be spoken: in the sessions measured, few replies were dropped after it |
| `onset_ms` | number or null | When the reply's first sound leaves the server. Null at first in `preparing` |
| `onset_exact` | boolean | False: `onset_ms` is an estimate made before any audio existed. True: the first sound is queued and its time is measured from the audio |
| `segments` | array | Each unbroken stretch of the reply's sound, in order, as `{start_ms, end_ms}`. The last one has `end_ms` null while its sound is still open. A gap between two segments is a pause: at least 150 ms of quiet inside the reply |
| `end_ms` | number or null | When the reply's last sound leaves the server. Null until all of the reply's audio is queued. While it is null, a closed segment is a pause, not the end |
| `words` | integer or null | The number of words in the reply's whole text, once the text is complete. For an interrupted reply it counts the whole text, not what was heard |

**How `onset_ms` is first estimated.** Before any audio exists, the bot adds a fixed delay to the moment it learns something: 510 ms after the first text, then 360 ms after speech is requested from the TTS service. These are the medians measured with Deepgram, OpenAI `gpt-5.5` and Cartesia `sonic-3.6`. They depend on the services and are estimates only; `onset_exact` says which kind a client has.

**What counts as sound.** 10 ms of audio within 25 decibels of the loudest 10 ms of the reply so far, and louder than 50 decibels below full scale. This is the rule of the turn-taking study the movement profiles are based on, applied to audio as it is queued.

---

## 5. From a message to the moment a client acts

A client acts on what the listener hears. It never compares the bot's clock with its own. Every time in a message is used as a **lead** over that message: a sound announced for bot time `T` in a message sent at `now_ms` leaves the server `T − now_ms` after the message did. The lead is negative when the sound has already left. The client hears that sound at about

```
arrival of the message + lead + sound lag
```

- **Arrival.** A message can be held up on the way, so a client uses the earliest arrival it has seen, not each message's own. In practice it keeps the smallest `arrival − now_ms` over the last few seconds of messages, repeats included, and adds it to `T`. A late message only makes its own value larger, so it does not disturb this.
- **Sound lag.** How much later the client hears a sound than its message says. It belongs to the client: it holds whatever the audio meets on its way that the message does not, and it differs between a browser on loudspeakers, a browser on Bluetooth headphones and a robot. The bot cannot know it, and this protocol does not ask the bot to. Two ways for a client to have it:
  - **Measure it from the sound.** The client notices when the bot's sound starts and stops, and compares that with the announced segment boundaries. The median difference is the lag. The browser client does this (`web/src/turn-cues.js`); in Chrome on macOS the lag was 100 to 155 ms from one session to the next. Until it has measured, it uses the lag of its last session, or 130 ms.
  - **Know it.** A client that plays the audio itself, such as a robot, knows how long its own playback path takes.

  A browser hears the sound on the decoded audio, before the loudspeaker. What the loudspeaker path adds comes on top: the playout delay from `RTCPeerConnection.getStats()`, and a manual adjustment for what that figure misses.

This is the scheme of pipecat-visemes, whose client also schedules against the arrival of its messages. There the lead is a fixed 200 ms, because the output transport releases each message that long before its audio. Turn cues are known between 0.4 and 6 seconds ahead, and sometimes late, so each message states its own lead.

Two rules follow.

- **Use (`turn`, `rev`), not arrival order, to decide which state is current.** Ignore a message whose `rev` is lower than the latest seen for its turn, and any message for an earlier turn.
- **A time in the past is still useful.** A message delayed by a stall can arrive after the moment it announces. A client should then act at once rather than skip the cue.

**Who does what.**

| | The bot | The client |
|---|---|---|
| Says when each sound leaves the server, as early as it knows | Yes | |
| Knows or measures the sound lag | | Yes |
| Decides when each movement starts | | Yes |
| Holds audio back to gain time | Never | Never |

The audio is never delayed for the body, by either side. A client can only schedule inside the lead it is given; when a lead is shorter than a movement needs, the movement adapts (section 6).

---

## 6. Guidance for a client

This section is advice, not part of the protocol. It describes the first client built on the message, a simple realizer that raises the simulated G1's arms and turns its torso (`web/src/robot/turn-realizer.js`, still available on the page with `?robot=demo`). The current client is the kinesics realizer, which follows the same timing rules with movements measured from human conversations and does not yet re-time a bid; it is described in `client.md`. "First sound" and "last sound" mean those sounds as the client will hear them (section 5).

| Cue | When to act |
|---|---|
| **Bid** (get ready to speak) | In place at the first sound. Start at the first message with `text_started`, or at the first sound minus the movement's own duration, whichever is later |
| **Hold** (stay in speaking posture) | Through the gap between two segments while `end_ms` is null or later than the gap |
| **Yield** (hand the turn over) | A movement that should be finished by the last sound starts its own duration before it (the G1's torso turn: 0.5 s). A movement that follows the sound starts at it (the G1's arms lowering) |
| **Cancelled** | Undo the bid at once |
| **Interrupted** | Return to listening at once |
| **No message at all** | Fall back on the audio the client hears: sound starts, sound stops |

Rules that came out of the live sessions:

- **Wait for `text_started` before the bid.** Replies dropped before their first text then never show a bid, and few are dropped after it. In the one case observed, the bid was undone a third of the way up.
- **When a cue leaves too little time, move faster, then finish late.** The G1 client shortens a movement down to 2/3 of its normal duration. With less time than that, it starts at once from wherever the body is and finishes after the moment it aimed at.
- **Re-time a bid when the exact first sound arrives.** A bid usually starts while `onset_exact` is false, on an estimate that can be off by 0.2 s or more. The exact time reaches a browser about 0.3 s before the sound is heard. If the movement is still under way, stretch or compress what is left of it to finish at the first sound (the first client allows a factor of 3/2 either way). Do this only once the sound lag is measured or known.
- **A short reply may leave no room for the yield.** A one-word reply lasts about half a second, so its `end_ms` arrives with little more lead than that, and a yield movement may have to start with the word.

**Reporting back.** Not part of version 1. The browser client includes its sound lag and every movement it started in the report it sends to the session recorder once a second (the `client_stats` client message). The bot records them and does not act on them.

---

## 7. Accuracy, as measured

All sessions were live conversations in Chrome with a microphone, using Deepgram, OpenAI `gpt-5.5` and Cartesia `sonic-3.6`. Session A ran the bot on a cloud host; sessions B and C ran the bot and the browser on one machine.

**The bot's side: announced times against the sound in the session's recording.** The recording is itself accurate to about one 40 ms piece of audio. Negative means announced earlier than measured.

| Session | First sound (`onset_ms`, exact) | Last sound (`end_ms`) | Pause boundaries (`segments`) | First estimate of the first sound |
|---|---|---|---|---|
| A: bot on a cloud host, 15 replies | −7 ms (−36 to +4) | +12 ms (0 to +35) | +10 ms (−10 to +38), 40 boundaries | +194 ms (−430 to +298) |
| B: bot and browser on one machine, 12 replies | −11 ms (−83 to +4) | +5 ms (−43 to +18) | −8 ms (−73 to +42), 36 boundaries | −33 ms (−196 to +138) |
| C: bot and browser on one machine, 8 replies | −11 ms (−49 to −5) | +2 ms (−39 to +14) | −2 ms (−39 to +14), 16 boundaries | +34 ms (−112 to +167) |

Values are the median and, in brackets, the range. The exact times hold to about one or two pieces of audio. The first estimate does not, which is why a client should treat `onset_exact: false` as a rough time.

**Lead available to a client**, against the sound heard there:

| Session | Message with `text_started`, before the first sound | Message with `end_ms`, before the last sound |
|---|---|---|
| A, bot on a cloud host | median 427 ms (352 to 1,112) | median 2,332 ms (729 to 9,900) |
| B, bot and browser on one machine | 553 to 827 ms | 574 to 6,289 ms |

**The client's side: the simulated G1's movements against the sound heard**, with the first client built on the message (section 6). Each value is the moment of the movement that should meet the sound, minus the sound; negative is early. These sessions ran before the sound lag had a starting value, so the cue column leaves out each session's first two turns.

| Movement | With the turn cues (session C, turns 3 to 10) | From the sound alone (a further session) |
|---|---|---|
| Bid: arms in place at the first sound | −11 to +33 ms, 6 turns | +430 ms, 8 turns |
| Yield: torso back by the last sound | −43 to +9 ms, 4 turns | Not possible: the end is not known before it is heard |
| Yield: arms start down at the last sound | −39 to +11 ms, 4 turns | +764 to +780 ms, 6 turns |

Not yet measured: the client's side with the bot on a cloud host. Timing of the current kinesics client is reported in the repository's README.

---

## 8. Adding it to a Pipecat bot

Diagrams of the whole pipeline and of the frames between its processors: `turn-cue-pipeline.md`. A reference for each processor, frame and observer: `pipecat-modules.md`.

Five processors around the TTS service, plus one observer:

```python
from kinesics_core.playout import AudioPlayout, PlayoutObserver
from turncue import ActionTagToRTVI, CascadeSpeechStage, ReplyTextTap, TagService, TurnCueGenerator

playout = AudioPlayout()
pipeline = Pipeline([
    transport.input(), rtvi, stt, user_turns, llm,
    ReplyTextTap(),                         # reports the reply's text past the TTS service
    tts,
    CascadeSpeechStage(playout),            # speech contexts from the TTS service's audio and word times
    TagService(TurnCueGenerator()),         # the turn's state
    ActionTagToRTVI(),                      # bot-turn-cue messages to clients
    transport.output(), assistant_turns,
])
task = PipelineTask(pipeline, observers=[RTVIObserver(rtvi), PlayoutObserver(transport.output(), playout)])

@rtvi.event_handler("on_client_ready")
async def on_client_ready(rtvi):
    playout.begin()                          # count queued audio from the moment a client listens
    ...
```

Requirements and limits of the current code:

- **The tap must sit directly before the TTS service** and the cascaded speech stage directly after it. The tap's report travels as a Pipecat system frame because the TTS service holds other frames it does not know behind audio already queued.
- **Output audio at 24,000 samples per second, mono.** The audio-queue measure (`kinesics_core/playout.py`) assumes it.
- **`playout.begin()` when the client is ready.** Before a client connects, Pipecat's WebRTC transport drops the audio it is given, so counting must start then.
- **Only Cartesia has been tried.** Any Pipecat TTS service that emits `TTSAudioRawFrame`, `TTSStartedFrame` and `TTSStoppedFrame` should work. Word times come from `TTSTextFrame` and only services with word timestamps provide them; version 1 of the message does not use them.

---

## 9. Not in version 1, and open points

- **Speculative replies.** A reply started before the user's turn is confirmed would need a flag that it may be withdrawn. It is planned for a later stage.
- **Listening behaviour.** The message says nothing about the user's turn.
- **Gesture tags.** The same frame (`ActionTagFrame`) is meant to carry them later under another `kind`, with their own message type.
- **A reply for the client.** The client does not tell the bot its sound lag or what it did through this protocol (section 6, "Reporting back").

**Open points.**
- **The first estimate of the first sound is fixed, and often wrong.** It is 510 ms after the first text, then 360 ms after the speech request, as measured with bot and browser on one machine. It was a median 194 ms late with the bot on a cloud host. It should be learned during the session from the replies already spoken.
- **A pause shift seen once.** In one reply of an early session, every pause boundary was announced 36 to 62 ms early. Its cause was not found, and later sessions did not show it (medians of +10, −8 and −2 ms above).
- **Short pauses can go unannounced.** In one reply, 2 short pauses of 7 were not in `segments`.
- **Where the sound lag comes from.** A browser's lag of 100 to 155 ms is more than its own audio buffering explains; the rest was not located. Measuring it makes this harmless for a client.

---

## 10. Changes

| Date | Change |
|---|---|
| 2026-11-17 | Version 1 |
