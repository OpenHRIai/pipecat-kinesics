# Movement parameter profiles for turn cues

*This document explains every value in `web/src/kinesics/profiles.json`, the movement parameters read by the kinesics realizer (the program that turns turn cue messages into motion), and every gain in `web/src/kinesics/mappings.json`. The measurements behind them are in `kinesics-movement-measurements.md`. The turn cue message is specified in `turn-cue-protocol.md`.*

**Terms used here.**
- **Profile**: one set of parameters for a setting. `video_call` is measured on CANDOR (video calls), `same_room` on Seamless Interaction (two people in one room).
- **Bid**, **yield**, **pause**: what a body shows before speaking, as its turn ends, and in a silence inside its turn.
- **First sound**, **last sound**: of the bot's reply, as the client hears them. All times are in milliseconds (ms) against one of them; negative is before.
- **Torso length**: shoulder line to hip line. Hand height is in this unit.

**How each value is marked.**
- **Measured**: read from a table of `kinesics-movement-measurements.md`.
- **Derived**: worked out from measured values by a stated rule.
- **Chosen**: a design decision, where the data give an average over people and one body must do one thing, or where the data give nothing.

**Licence.** CC BY-NC 4.0 (non-commercial), because the `same_room` values and all hand and torso values are derived from Seamless Interaction.

---

## 1. Three design decisions behind the values

1. **One body looks away or does not.** The measured shares average people who look away and people who do not. The body looks away for a reply longer than 1.6 s, or of unknown length, and keeps facing the partner for a shorter one. The 1.6 s threshold is chosen.
2. **Eye angles are approximate.** The tracks give iris position in eye widths. Degrees here assume an eye 29 mm wide from corner to corner and an eyeball of 12 mm radius. Both are textbook round figures, not measured on these people.
3. **Glances at the partner while speaking are scheduled, not measured.** The measured share of time on the partner is kept (35% on calls, 28% in the room). The length of a glance is chosen, because the measured lengths are distorted by a flickering label.

---

## 2. Head and eyes

Values are `video_call` / `same_room`.

### Listening

| Parameter | Value | Kind | Source |
|---|---|---|---|
| `head_speed_dps` | 4.4 / 5.5 degrees per second | Measured | Median head speed while listening |
| `head_scatter_deg` | 3.9° / 3.9° | Measured | Median head angle away from the partner while listening. The size of the small drift around the partner direction |

### Speaking

| Parameter | Value | Kind | Source |
|---|---|---|---|
| `head_away_deg` | 9.5° / 9.9° | Derived | The head is on the partner in 41% / 35% of speaking frames, so the frames away are the upper 59% / 65% of head angles. Their middle is the 70th / 67th percentile, interpolated between the measured median (6.6° / 7.2°) and 75th percentile (10.2° / 11.0°) |
| `eye_away_deg` | 10° / 10° | Derived, approximate | The same rule on the iris offset gives 0.071 / 0.073 eye widths, converted with decision 2 |
| `head_pitch_deg` | −2.3° / −0.5° | Measured | Mean head pitch in mid-turn against listening. Speakers on calls hold the chin lower |
| `head_speed_dps` | 11.8 / 15.4 degrees per second | Measured | Median head speed while speaking |
| `partner_share` | 0.35 / 0.28 | Measured | Share of speaking frames with head and eyes on the partner |
| `glance_ms` | 800 ms | Chosen | Decision 3. With the share above, a glance comes every 2.3 s / 2.9 s |
| `away_min_reply_ms` | 1,600 ms | Chosen | Decision 1 |

### Bid

| Parameter | Value | Kind | Source |
|---|---|---|---|
| `look_away_start_ms`, `look_away_end_ms` | −700 ms, +300 ms | Measured, rounded | The share on the partner falls from about 1 s before the first word, fastest in the last 0.5 s, and levels out 0.3 s after. The start is set at −700 ms because a client rarely knows of a reply earlier (`turn-cue-protocol.md`, section 7) |
| `head_move_start_ms` | −500 ms | Measured | Head speed leaves its listening level in the last 0.5 s |
| `dip_deg` | −0.6° / −0.6° | Measured | Extra chin dip below the speaking pitch at its lowest: −3.0° against −2.3° on calls, −1.2° against −0.5° in the room |
| `dip_peak_ms`, `dip_end_ms` | +200 / +100 ms, +1,500 ms | Measured, rounded | The pitch is lowest 0.1 to 0.3 s after the first word and back at its speaking level within about 1.5 s |
| `speed_peak_factor`, `speed_peak_ms` | 1.15 / 1.1, +100 ms | Measured | Head speed peaks 0.1 s after the first word at 22.2 / 26.8 degrees per second, against a mid-turn mean of 18.6 / 24.8 |
| `blink_ms` | 0 ms | Measured | The share of frames with closed eyes peaks at the first word (22% against 9% in the room, 33% against 25% on calls). One blink is placed there |

### Pause

| Parameter | Value | Kind | Source |
|---|---|---|---|
| `slow_start_ms` | −700 ms | Measured | Head speed falls from 0.7 s before the last sound before a pause |
| `speed_factor` | 0.88 / 0.83 | Measured | Head speed at that last sound against 0.7 s earlier: 16.1 against 18.3, and 18.5 against 22.3 degrees per second |
| `chin_rise_deg` | +0.5° / +0.6° | Measured | Rise of the pitch over the same 0.7 s |
| `resume_ms` | 200 ms | Measured | Head speed is back up 0.2 s after the speaker resumes |
| `resume_dip_deg` | −0.8° / −0.9° | Measured | Fall of the pitch from 0.7 s before resuming to 0.3 s after |
| Gaze | No parameter | Measured | Nothing returns to the partner in a pause, so the body keeps looking where it was |

### Yield

| Parameter | Value | Kind | Source |
|---|---|---|---|
| `eyes_return_start_ms`, `eyes_return_end_ms` | −600 ms, −100 ms | Measured start, chosen end | The share of eyes on the partner rises from about 0.7 s before the last sound and is still rising a second after. One body has to arrive at some moment: just before the last sound, as in the study's published example (eyes back 0.6 s before the stop) |
| `head_return_start_ms`, `head_return_end_ms` | −300 ms, +700 ms | Measured, rounded | The head's share starts to rise 0.3 s before the last sound and gains most of its return in the second after it |
| `head_pitch_deg` | +0.5° / +0.6° | Measured | Mean pitch 0.3 to 1 s after the last sound, against listening |
| `pitch_start_ms`, `pitch_end_ms` | −700 ms, +300 ms | Measured, rounded | The pitch rises over this stretch |
| `settle_end_ms` | +1,000 ms | Measured, rounded | Head speed is near its listening level a second after the last sound (12.3 / 14.4 degrees per second, still falling) |
| `blink_rate_factor` | 1.0 / 0.6 | Measured | After a turn end, closed-eye frames fall from 15% to 9% in the room and do not fall on calls |

### Blink

| Parameter | Value | Kind | Source |
|---|---|---|---|
| `rate_per_min` | 15 blinks per minute | Chosen | A common figure for conversation. The tracks give the share of frames with closed eyes, which depends on video resolution (9 to 15% in the room, 25 to 30% on calls) and does not give a rate |
| `closed_ms` | 150 ms | Chosen | A typical blink length |

---

## 3. Hand and torso lean

Measured in the same room only (Seamless Interaction, 540 conversations) and used with either profile.

| Parameter | Value | Kind | Source |
|---|---|---|---|
| `hand.rise_tl` | 0.3 torso lengths | Measured, rounded down | 75th percentile of the hand's rise while speaking (0.33) |
| `hand.rise_start_ms`, `hand.rise_end_ms` | −100 ms, +700 ms | Measured | The share of raised hands is at its listening level 0.5 s before the first word (19%), 25% at the first word and 38% by 0.7 s after |
| `hand.hold_in_pause` | true | Measured | 53% raised before a pause, 50% at 0.3 s into it |
| `hand.lower_start_ms`, `hand.lower_end_ms` | −1,000 ms, +700 ms | Measured | The share falls from 45% a second before the last sound to 35% at it and 25% at 0.7 s after |
| `hand.min_reply_ms` | 1,600 ms | Chosen | Decision 1, applied to the hand: half of speakers have no hand raised at a given moment |
| `torso_lean.speaking_deg` | −0.5° | Measured | Mean lean 0.5 s after the first word against listening (−0.4°); negative is read as away from the partner |
| `torso_lean.bid_start_ms`, `bid_end_ms` | −300 ms, +500 ms | Measured, rounded | The lean changes over this stretch |
| `torso_lean.yield_deg` | +0.7° | Measured | Mean lean 0.5 to 1 s after the last sound |
| `torso_lean.yield_start_ms`, `yield_end_ms` | −700 ms, +500 ms | Measured, rounded | |

---

## 4. Mouth

The mouth opens before the first sound, earlier than any other cue. The moments are taken from the turn-taking study on the same two corpora, as reported there; they were not measured again for this document. Opening is a share of the speaker's usual opening while speaking: 0 is closed, 0.5 is "half open".

| Value | `video_call` | `same_room` | Kind | Source or reason |
|---|---|---|---|---|
| `quarter_open_ms` | −830 ms | −720 ms | Measured | Before a long utterance the mouth is a quarter open this long before the first word |
| `half_open_ms` | −430 ms | −430 ms | Measured | And half open this long before it, on both corpora |
| `short_half_open_ms` | −140 ms | −100 ms | Measured | Before a short reply ("yeah") the mouth is half open only this long before the sound |
| `min_long_reply_ms` | 1,600 ms | 1,600 ms | Chosen | A reply known to be shorter opens late. The same threshold as the look away |
| `pause_hold_ms` | 1,000 ms | 1,000 ms | Measured | In a pause with more to come the mouth stays half open for the first second; in longer pauses it closes |
| `open` | 0.5 | 0.5 | Derived | "Half open", the level the study's moments refer to |
| `short_open_dur_ms` | 200 ms | 200 ms | Chosen | How long the late opening takes |
| `speaking_floor`, `floor_start_ms`, `floor_end_ms` | 0.15, 100 ms, 400 ms | same | Chosen | Once the sound is there, the resting posture drops to a small opening so the lips can close on consonants |
| `pause_open_ms`, `pause_close_ms` | 150 ms, 300 ms | same | Chosen | How fast the mouth reaches half open in a pause, and how fast it closes after the first second |
| `resume_start_ms`, `resume_end_ms` | −300 ms, −100 ms | same | Chosen | After a long pause the mouth opens again just before the sound resumes. The study found a speaker resuming after 2.5 s or more opens as early as at a turn start (half open 0.30 s ahead on video calls, 0.42 s in the same room); the segment's start is rarely known that early, so a shorter run-up is used |
| `close_start_ms`, `close_end_ms` | 0 ms, 250 ms | same | Chosen | The mouth closes with the last sound |

**How the early opening is drawn.** One movement on the realizer's smooth curve, placed so that it passes a quarter open at `quarter_open_ms` and reaches half open at `half_open_ms`. On that curve the halfway value falls at half the duration, so the movement lasts twice the time between the two moments: 800 ms starting 1,230 ms before the first sound (`video_call`), 580 ms starting 1,010 ms before it (`same_room`).

**It starts on the bot's `preparing` state, before the reply's first text.** In a live session of 9 turns (Chrome, a microphone, bot and browser on one machine), an opening that waited for the first text, as the other bid movements do, began a median 625 ms before the sound and reached half open 239 ms before it (range 113 to 271 ms), against the human 430 ms. The `preparing` state, sent when the language model starts on the reply, reached the client a median 1,368 ms before the sound and never less than 1,263 ms. The mouth alone therefore moves on that state: a quarter open at once (`ready_on_preparing`, `ready_open` 0.25, `ready_dur_ms` 290 ms, all chosen), held until the first text gives a time for the sound, then on to half open at `half_open_ms`. No time for the sound is known at `preparing` and the wait varied from 1.3 to 2.6 s, so the quarter-open posture is sometimes held for a second or more; the study saw such a readiness posture on video calls. A reply dropped at this stage closes the mouth again (2 of 11 replies in that session). In the study, 43% of such mouth run-ups in the Seamless Interaction development set were likewise abandoned. Head and eyes still wait for the first text.

| Value | Both profiles | Kind |
|---|---|---|
| `ready_on_preparing` | true | Chosen |
| `ready_open` | 0.25 | Derived: "a quarter open", the first of the study's two levels |
| `ready_dur_ms` | 290 ms | Chosen: the time between the two measured moments in the same-room data |

**The early opening announces a long utterance, not turn-taking as such** (the study's finding). Whether a reply is long is usually unknown when the opening must start, so an unknown length is treated as long.

---

## 5. Mappings: which joint shows what

How a cue is shown on a body is decided on the client. The bot sends only the turn's state, and the realizer's output is body-neutral. What goes to which joint or bone, and how much, is a **mapping**: a table in `web/src/kinesics/mappings.json` that a client selects per session (`?g1map=` and `?vrmmap=` in the page address). A new way of showing a cue is a new entry in that file, with no change to code.

**How a mapping reads.** Each target (a G1 joint, or a bone and axis of the avatar) is its rest value plus the sum of gain × source, in degrees.

| Source | What it is |
|---|---|
| `head_away`, `eye_away` | Degrees the head and the eyes are away from the partner, unsigned |
| `head_away_sided`, `eye_away_sided` | The same, signed to the side the body looks away to |
| `head_pitch` | Degrees, chin up positive |
| `live_yaw`, `live_pitch` | The small continuous head motion, degrees |
| `torso_lean` | Degrees, towards the partner positive |
| `hand` | 0 at rest, 1 raised |
| `blink` | 0 open, 1 closed |
| `mouth` | The mouth's resting posture: 0 closed, 1 the usual opening while speaking |
| `const` | Always 1, for a resting pose |

**Every gain is chosen, not measured.** The profiles describe what people do; a mapping is a design judgement about how a particular body should show it.

### The G1

The G1 has three waist joints (turn, lean forward and back, tilt sideways), a head fixed to the torso, and no eyes. An observer reads where it is looking from where its torso points.

| Mapping | The look away | Gains |
|---|---|---|
| `side` | A waist turn to the side: about 7.8° while speaking, glances back of about 4° | Waist turn = 0.4 × (head away + eyes away) |
| `forward` (default) | A forward bend at the waist of the same size, on top of the lean from the head's pitch, so the chest keeps facing the partner | Waist lean = −1 × head pitch + 0.4 × (head away + eyes away) |

Common to both:

| Choice | Value | Why |
|---|---|---|
| Size of the look away | 0.4 of the head's and the eyes' angles | At full size (19.5°) the chest and shoulders stay turned away from the partner for the whole reply. On a person the look away is a head and eye movement on a body that keeps facing the partner |
| The eyes' part | Counted in full beside the head's | So that the glances back at the partner, which are made with the eyes, stay visible |
| Head pitch | Waist lean of the same size | Chin 2.3° / 0.5° lower while speaking becomes a lean forward |
| The return at the yield | On the eyes' timing (`head_returns_with_eyes`) | The return is the cue a partner reads, and the torso is the only thing that can show it |
| The small continuous motion | Not shown (gain 0) | It would move the whole upper body all the time, costs a real robot balance effort and wear, and blurs cues that are now only a few degrees. Its measured size also mixes posture shifts, nods and tracker noise (see below) |
| The human torso lean | Not shown | The waist already stands for the head |
| Arm | The right arm: elbow 31.5° and shoulder 11.5° from rest | Estimated from the forearm's length to lift the hand by about 0.3 torso lengths; not measured on the model. The data cannot say which arm (hand height is the higher of the two wrists) |

**Why `forward` is the default.** With `side` the robot turns its front away from the person it is talking to. A forward bend keeps it facing them. The meaning shifts with it: a glance aside is a brief withdrawal of attention, while leaning in usually reads as engagement, so `forward` is its own signal with gaze's timing, not a stand-in for gaze. On hardware a bend moves the upper body's weight ahead of the feet, which a turn does not.

### The avatar

| Mapping | Choices |
|---|---|
| `natural` (default) | The neck takes 40% of each head angle and the head bone 60% (an animation convention). Eyes, blink and torso lean at their measured size. Arms hang 72° down from the model's default pose; a raised hand bends the right elbow to 64°, which lifts the wrist by about 0.3 torso lengths on this model (calculated, not measured on the model). The small continuous motion at a quarter of its measured size. Relaxed hands (chosen, not measured; the body tracks used have no fingers): each wrist bends 8° towards the palm and 5° towards the little finger; the fingers curl at their three joints from 12°, 18°, 10° (index) to 22°, 30°, 16° (little finger); the thumb sits 15° in front of the palm with an 8° bend. When the right hand is raised its fingers open by a third and its wrist straightens by half |

**The small continuous motion is too large as measured.** The profile's 3.9° and 4.4 to 5.5 degrees per second describe how far a listener's head is from its own average direction and how fast it moves. That includes posture shifts, nods and tracker noise, and reproducing all of it as a constant sway makes the avatar look restless. The relative changes (faster when speaking, slower before a pause, settling after the yield) are kept; the size is a gain in the mapping.

The mouth has two parts. Its resting posture is a turn cue (section 4) and goes through the mapping: target `mouth`, the model's open-mouth expression, at 0.8 of the profile's share, so "half open" shows as 0.4 of the model's full opening (chosen, so that the cue is visible on this model). The lip movement on top of it is a placeholder, opened by the loudness of the bot's audio. The larger of the two is shown.

---

## 6. Open points

- **The sign of pitch** is read as chin up from the study's label and was not checked on video.
- **Averages are small.** A chin dip of 0.6° and a torso lean of 0.5° may not be visible on a body. They are kept at their measured size; exaggerating them would be a separate decision.
- **Glance length and blink rate are chosen**, not measured.
- **Every mapping gain is a design judgement.** Whether a viewer reads the G1's forward bend, or its smaller turn, as the cue is untested.
- **Half of the G1's look away rests on the approximate eye angle.**
- **Torso turn is not measured.** The waist turn comes from head and eye angles. The dataset's full joint rotations could measure it.
- **Whether a viewer reads these movements as the cues** is untested.
