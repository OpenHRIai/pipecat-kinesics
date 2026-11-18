# The Pipecat modules (bot side)

*Reference for the code in `server/turncue/` and `server/kinesics_core/`: the processors, frames and
observers this project adds to a Pipecat bot so that it sends turn cues. The message they produce
is specified in `turn-cue-protocol.md`. Figures of the pipeline and of the frames between the
processors are in `turn-cue-pipeline.md`. Written against Pipecat 1.12.*

**Terms used here.**
- **Frame**: Pipecat's unit of data between processors. A *system frame* is handled at once and
  overtakes frames that are waiting; an interruption does not cancel it. Other frames wait their
  turn and are cancelled by an interruption.
- **Processor**: a Pipecat `FrameProcessor`, one stage of the pipeline.
- **Observer**: a Pipecat `BaseObserver`. It is told about every frame any processor pushes and
  changes nothing.
- **STT**: speech-to-text. **LLM**: large language model. **TTS**: text-to-speech.
- **RTVI**: Pipecat's protocol for messages between a bot and its clients.
- **Reply**: one answer of the bot, from the LLM's first token to its last audio.
- **Bot clock**: one monotonic clock chosen by the bot, in milliseconds. `default_clock()` counts
  from the moment `turncue` is loaded.

---

## 1. Overview

```
llm -> ReplyTextTap -> tts -> CascadeSpeechStage -> TagService(TurnCueGenerator) -> ActionTagToRTVI -> transport.output()
                                     |                                                                    ^
                                     +---- AudioPlayout <---- PlayoutObserver (watches transport.output()) -+
```

| Module | Kind | In one sentence |
|---|---|---|
| `ReplyTextTap` | Processor | Reports each reply's start, first text and whole text to the stage after the TTS service |
| `CascadeSpeechStage` | Processor | Turns the TTS service's audio and events into one `SpeechStepFrame` per piece of audio or event, each stamped with the time its sound will leave the server |
| `TurnCueGenerator` | Plain class | Keeps the state of the bot's turn and returns it whenever it changes |
| `TagService` | Processor | Runs a generator on every `SpeechStepFrame` and pushes its results as `ActionTagFrame` |
| `ActionTagToRTVI` | Processor | Sends each `ActionTagFrame` to clients as an RTVI server message, and repeats the latest once a second |
| `AudioPlayout` | Plain class | Counts how much audio is waiting in the output transport |
| `PlayoutObserver` | Observer | Keeps `AudioPlayout` up to date from what the output transport has sent |
| `CensusRecorder`, `CensusObserver` | Plain class, observer | Optional: record a session (audio, events, the client's reports) for the timing reports |

The minimal wiring is in `turn-cue-protocol.md`, section 8, and the complete bot is
`server/bot_cascade.py`.

---

## 2. Frames

Defined in `server/turncue/frames.py` and `server/kinesics_core/frames.py`.

| Frame | Pipecat type | From → to | Carries |
|---|---|---|---|
| `ReplyTextFrame` | System frame | `ReplyTextTap` → `CascadeSpeechStage` (consumed there) | `reply`: a `ReplyEvent` |
| `SpeechStepFrame` | Data frame | `CascadeSpeechStage` → `TagService` (consumed there) | `step`: a `SpeechStep` with the audio samples and a `SpeechContext`; `pts_ms`, `seq` |
| `ActionTagFrame` | System frame | `TagService` → `ActionTagToRTVI` (consumed there) | `kind` (`"turn"`) and `data`, the message's fields as they go on the wire |
| `RTVIServerMessageFrame` | Pipecat's own | `ActionTagToRTVI` → the RTVI observer → the client | `data`: the `bot-turn-cue` message |

**Why two of them are system frames.**
- `ReplyTextFrame`: the TTS service passes system frames on at once, but holds any other frame it
  does not know behind audio already queued for synthesis. As a data frame, a reply's first text
  would wait for the previous audio and the early warning would be lost.
- `ActionTagFrame`: an interruption cancels data frames in flight. The tag that reports the
  interruption must not be one of them.

**`ReplyEvent`** (`reply_id`, `event`, `t_ms`, `text`) says what happened to one reply and when, on
the bot clock. `reply_id` is the `id` of the `LLMFullResponseStartFrame` that opened the reply, or 0
for speech that did not come from the LLM.

| `event` | Meaning | Reported by |
|---|---|---|
| `preparing` | The LLM started a reply | `ReplyTextTap` |
| `first_text` | Its first text that is not whitespace | `ReplyTextTap` |
| `text_complete` | All of its text | `ReplyTextTap` |
| `speech_requested` | The TTS service started (`TTSStartedFrame`) | `CascadeSpeechStage` |
| `audio` | A piece of synthesized audio was queued for sending (`TTSAudioRawFrame`) | `CascadeSpeechStage` |
| `words` | Word timestamps arrived (`TTSTextFrame` with a time) | `CascadeSpeechStage` |
| `speech_done` | The TTS service finished; all audio is queued (`TTSStoppedFrame`) | `CascadeSpeechStage` |
| `stopped` | The last audio was sent (`BotStoppedSpeakingFrame`, the copy travelling upstream) | `CascadeSpeechStage` |
| `interrupted` | The user spoke; queued audio was dropped (`InterruptionFrame`) | `CascadeSpeechStage` |

**`SpeechContext`** fields used by the cascaded path: `reply` (the `ReplyEvent`), `audio_send_ms`
(when the first sample of this piece leaves the server, bot clock), `sample_rate`, `words` (a list
of `(word, time in ms)`).

---

## 3. `ReplyTextTap`

`ReplyTextTap(*, clock=default_clock)`

- **Place:** directly before the TTS service.
- **Passes on:** every frame, unchanged, in both directions.
- **Reads (downstream only):** `LLMFullResponseStartFrame`, `LLMTextFrame`,
  `LLMFullResponseEndFrame`.
- **Pushes:** a `ReplyTextFrame` for `preparing`, `first_text` and `text_complete`.
- **Why it exists:** the TTS service consumes the reply's text. Pipecat 1.12 does not pass text
  frames on for services with word timestamps (Cartesia among them), so nothing after the TTS
  service can see when the text began.

## 4. `CascadeSpeechStage`

`CascadeSpeechStage(playout, *, clock=default_clock)`

- **Place:** directly after the TTS service.
- **`playout`:** the `AudioPlayout` that a `PlayoutObserver` on the output transport keeps up to
  date.
- **Passes on:** everything except `ReplyTextFrame`, and passes it on first, audio included, so it
  adds no delay to the audio.
- **Pushes:** one `SpeechStepFrame` per event in the table of section 2.
- **How it knows when sound will leave the server:** the output transport sends audio in real
  time, so a piece of audio leaves at *now + the audio already waiting in the transport's queue*.
  It reads that queue length from `playout.queued_ms` and tells `playout` about every piece it
  hands over.
- **On an interruption:** calls `playout.flush()`, because the output transport drops the audio it
  holds.

## 5. `TurnCueGenerator`

`TurnCueGenerator(*, pause_ms=150.0)` in `server/turncue/generator.py`. Not a processor: a plain
class with no Pipecat dependency, so it can be tested on its own.

| Method | Does |
|---|---|
| `step(speech)` | Takes one `SpeechStep`. Returns `(tags, timings)`: `tags` is a list with the new state if the state changed, else empty |
| `state()` | The current state as the message's fields, without `now_ms` |
| `reset()`, `close()` | Start of a session, end of a session |
| `requires = ("reply",)` | The `SpeechContext` fields it reads; `TagService` checks they are present |

What changes the state, for one reply:

| Event | `status` after | What changes |
|---|---|---|
| `preparing` | `preparing` | A new `turn`; nothing known about the sound yet |
| `first_text` | `preparing` | `text_started`; `onset_ms` estimated at 510 ms later |
| `speech_requested` | `preparing` | `onset_ms` estimated at 360 ms later |
| First audible audio | `speaking` | `onset_ms` exact; the first segment opens |
| A pause in the audio | `speaking` | The open segment closes; the next opens after the pause |
| `text_complete` | unchanged | `words` |
| `speech_done` | unchanged | The last segment closes; `end_ms` is set |
| `stopped` | `ended` | |
| `interrupted` | `interrupted`, or `cancelled` if no sound had left yet | `end_ms` is the moment of the cut |

Constants at the top of the file, all chosen or measured for the services tried (Deepgram, OpenAI
`gpt-5.5`, Cartesia `sonic-3.6`):

| Constant | Value | Meaning |
|---|---|---|
| `FIRST_TEXT_TO_SOUND_MS` | 510 ms | First estimate of the first sound, counted from the first text. Measured median; service-specific |
| `SPEECH_REQUEST_TO_SOUND_MS` | 360 ms | Second estimate, counted from the speech request. Measured median; service-specific |
| `AUDIBLE_DB` | 25 decibels | Audio counts as sound when within this of the loudest 10 ms of the reply so far |
| `FLOOR_DBFS` | −50 decibels relative to full scale | And never quieter than this |
| `PAUSE_MS` | 150 ms | A quiet stretch at least this long inside a reply is a pause |
| `FRAME_MS` | 10 ms | The length of audio judged at a time |

## 6. `TagService`

`TagService(generator)`

- **Consumes:** every `SpeechStepFrame`. It calls `generator.step(...)` inline (a tag generator is
  cheap) and logs a warning if a step takes more than 5 ms.
- **Pushes:** an `ActionTagFrame(kind="turn", data=...)` for every tag returned.
- **Passes on:** everything else. Calls `generator.reset()` on `StartFrame` and `generator.close()`
  on `EndFrame` or `CancelFrame`.

To add another kind of tag, write a class with `requires`, `step`, `reset` and `close`, and give it
to a `TagService`.

## 7. `ActionTagToRTVI`

`ActionTagToRTVI(*, clock=default_clock, recorder=None, heartbeat_s=1.0)`

- **Consumes:** every `ActionTagFrame`.
- **Pushes:** an `RTVIServerMessageFrame` whose `data` is the tag's fields plus `now_ms`, the bot
  clock at the moment of sending. Pipecat's RTVI observer delivers it to clients.
- **Repeats:** every `heartbeat_s` seconds it sends the latest state again with a new `now_ms` and
  the same `turn` and `rev`. Before the first turn that state is `idle`. Clients use the repeats to
  keep their arrival reference fresh (`turn-cue-protocol.md`, section 5). `heartbeat_s=0` switches
  the repeat off.
- **`recorder`:** if given, `recorder.event("turn_cue", heartbeat=..., msg=...)` is called for
  every message sent.
- **Requires:** an `RTVIProcessor` in the pipeline and an `RTVIObserver` on the task, as in any
  Pipecat bot that talks to an RTVI client.

## 8. `AudioPlayout` and `PlayoutObserver`

In `server/kinesics_core/playout.py`.

`AudioPlayout()` counts bytes of audio handed to the output transport and bytes it has sent.

| Member | Meaning |
|---|---|
| `begin()` | Start counting. Call it when the client is ready: before a client connects, Pipecat's WebRTC transport drops the audio it is given |
| `handed(nbytes)` | Audio was handed to the transport (called by `CascadeSpeechStage`) |
| `sent(nbytes)` | The transport sent audio (called by `PlayoutObserver`) |
| `flush()` | The transport dropped what it held (an interruption) |
| `queued_ms` | How many milliseconds of audio are waiting now |

`PlayoutObserver(transport_output, playout, recorder=None)` is given to the `PipelineTask` as an
observer. It sees each `OutputAudioRawFrame` the output transport pushes on after sending it.

**Limit:** the count assumes 16-bit mono audio at 24,000 samples per second (`BYTES_PER_MS = 48`).

Nothing here changes how Pipecat sends audio. Audio is never held back for the body.

## 9. Recording a session (optional)

In `server/turncue/census.py`. `server/bot_cascade.py` uses it when the environment variable
`KINESICS_RECORD` is 1 (the default).

- `CensusRecorder(root, meta=None)` writes one folder per session: `session.json`, `events.jsonl`
  (one line per event with its time), `agent.wav` and `user.wav` (laid on the send clock), and
  `client.jsonl` (the client's reports).
- `CensusObserver(transport_input, transport_output, recorder)` writes the frames that matter to
  the recorder, including the client's `client_stats` messages.

Two tools read such a folder: `server/tools/census_report.py` compares the times the bot announced
with the sound in the recording, and `server/tools/kinesics_report.py` compares the client's
movements with the sound it heard.

**A session folder contains the user's voice.** Keep it out of version control (the repository's
ignore rules do).

## 10. Requirements and limits

- **Order matters:** the tap directly before the TTS service, the speech stage directly after it.
- **Tried with Cartesia only.** Any Pipecat TTS service that emits `TTSAudioRawFrame`,
  `TTSStartedFrame` and `TTSStoppedFrame` should work; that has not been checked.
- **The two first-sound estimates are fixed numbers** measured with one set of services. With other
  services, or a bot far from them, the estimate is worse (it was a median 194 ms late with the bot
  on a cloud host). The exact time that follows is not affected.
- **One speaker, one reply at a time.**
- **Tests:** `server/tests/test_turncue.py` covers the generator on its own (a reply with a pause,
  short dips that are not pauses, cancelled against interrupted) and the whole path in a real
  Pipecat pipeline with a synthetic TTS stage and an interruption; `server/tests/test_census.py`
  covers the recorder's audio track.
