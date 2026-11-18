# Movement measurements for turn cues: head, eyes, torso and hand

*This document reports how far and how fast people move the head, eyes, torso and hands around the start of a speaking turn, a pause inside it, and its end, in physical units. The parameter profiles used by the kinesics realizer are derived from these tables (`kinesics-profiles.md`). The turn cue message is specified in `turn-cue-protocol.md`.*

**Terms used here.**
- **Bid**: what a body shows before it starts to speak. **Yield**: what it shows as its turn ends. **Pause**: a silence inside a turn, after which the same speaker goes on.
- **Seamless**: the Seamless Interaction dataset (Meta): two people talking in the same room, filmed full-body. Licence CC BY-NC 4.0 (non-commercial).
- **CANDOR**: the CANDOR Corpus (BetterUp Labs): strangers talking on video calls, webcam video of head and shoulders. The CANDOR Corpus License, version 2.1, permits sharing aggregate statistics and does not permit redistributing the corpus.
- **Towards the partner**: per person, the median head angle and iris position over that person's own listening frames, as in the study. On a video call the partner is the screen.
- **Torso length**: the distance from the shoulder line to the hip line in the image. Hand height is given in this unit.

---

## 1. Source and method

The measurements extend a study of turn exchanges in two corpora of recorded conversations, Seamless Interaction and CANDOR (["Two Faces of a Turn Exchange"](https://openhri.ai/research/turn-taking-faces/)). That study reports head and gaze findings in standardized units: Cohen's d, z-scores and percentage points. A body needs degrees and seconds. The numbers below are measured from the same face and body tracks, with the same events and the same clock, which places each event on the audible start or end of speech.

- **Face tracks:** head yaw, pitch and roll in degrees and iris position in eye widths, at 10 Hz (frames per second), for both corpora.
- **Body tracks:** torso pitch in degrees and hand height in torso lengths, at 10 Hz, for Seamless Interaction only. CANDOR shows head and shoulders.

Only aggregate statistics are published here. No recording, track or frame of either corpus is included.

## 2. Limits of the body data

The body tracks are a reduced form of the dataset's pose data: torso pitch, and the height of the higher wrist against the shoulder line. They give torso lean and hand height around bids, pauses and yields: when a hand rises, how far, how often, whether it stays up in a pause, and when it comes down. They cannot give:

- **Which arm.** Hand height is the higher of the two wrists.
- **The arm pose.** The measurement gives timing, height and frequency. The arm pose that puts a hand at that height on a given body is a design choice.
- **Torso turn and tilt.** Only the forward and back lean is in these tracks.
- **Video calls.** There is no CANDOR counterpart.

The dataset's full joint rotations would give shoulder and elbow angles and torso turn. They were not used.

---

## 3. Head and eyes

Values are Seamless / CANDOR. Seamless: 2,092 persons, 7,162 turn ends, 7,162 bids, 36,235 pauses. CANDOR: 3,172 persons, a sample of 12,000 turn ends, 12,000 bids and 24,000 pauses. Angles are measured from each person's "towards the partner" direction. Shares are of video frames; "on the partner" uses the study's measure, which counts 70% of a person's listening frames as on the partner by construction.

**Levels.**

| | Listening | Speaking |
|---|---|---|
| Head angle away from the partner, median | 3.9° / 3.9° | 7.2° / 6.6° |
| Same, 75th and 90th percentile | 6.4° and 9.7° / 6.1° and 9.3° | 11.0° and 15.5° / 10.2° and 14.8° |
| Horizontal part of it, median | 2.0° / 2.1° | 4.1° / 3.7° |
| Head speed, median | 5.5 / 4.4 degrees per second | 15.4 / 11.8 degrees per second |
| Iris offset from its on-partner position, median | 0.020 / 0.028 eye widths | 0.044 / 0.046 eye widths |
| Share of frames on the partner: head alone, eyes alone, both | 70%, 70%, 70% (by construction) | 35%, 36%, 28% / 41%, 44%, 35% |

**Bid: the listener who takes the turn, timed on that listener's first word.**

| Signal | 2 s before | 0.5 s before | First word | 0.3 s after | 1 s after |
|---|---|---|---|---|---|
| Head on the partner, share of frames | 64% / 62% | 57% / 55% | 45% / 46% | 39% / 41% | 40% / 40% |
| Eyes on the partner, share of frames | 64% / 66% | 48% / 55% | 33% / 43% | 32% / 39% | 37% / 40% |
| Head angle away from the partner, mean | 6.4° / 6.1° | 7.1° / 6.9° | 8.4° / 7.9° | 9.0° / 8.6° | 9.1° / 8.9° |
| Head pitch against listening, mean | +0.2° / −0.1° | −0.3° / −1.2° | −1.1° / −2.5° | −1.0° / −3.0° | −0.2° / −2.5° |
| Head speed, mean, degrees per second | 12.4 / 12.0 | 15.3 / 14.7 | 24.7 / 21.0 | 25.2 / 20.8 | 21.1 / 17.6 |
| Eyes closed, share of frames | 9% / 25% | 13% / 26% | 22% / 32% | 19% / 32% | 15% / 31% |

**Yield: the speaker, timed on the last sound of a turn that the partner then takes.** Frames after the partner starts are left out.

| Signal | 2 s before | 0.5 s before | Last sound | 0.3 s after | 1 s after |
|---|---|---|---|---|---|
| Eyes on the partner, share of frames | 41% / 52% | 45% / 55% | 52% / 59% | 56% / 61% | 60% / 64% |
| Head on the partner, share of frames | 41% / 47% | 40% / 50% | 44% / 52% | 47% / 53% | 53% / 57% |
| Head angle away from the partner, mean | 9.3° / 7.5° | 8.8° / 7.1° | 8.2° / 6.9° | 7.9° / 6.8° | 7.4° / 6.6° |
| Head pitch against listening, mean | +0.1° / −1.1° | 0.0° / −0.4° | +0.6° / +0.3° | +0.7° / +0.5° | +0.5° / +0.6° |
| Head speed, mean, degrees per second | 21.4 / 17.1 | 25.1 / 17.5 | 19.7 / 15.8 | 17.9 / 15.1 | 14.4 / 12.3 |
| Eyes closed, share of frames | 15% / 29% | 15% / 32% | 10% / 30% | 9% / 29% | 10% / 27% |

**Pause: the speaker, timed on the last sound before a pause.** Frames after the speaker resumes are left out. The median pause lasts 0.63 s / 0.62 s.

| Signal | 2 s before | 0.7 s before | Last sound | 0.3 s after |
|---|---|---|---|---|
| Eyes on the partner, share of frames | 34% / 43% | 34% / 44% | 35% / 43% | 33% / 42% |
| Head on the partner, share of frames | 34% / 41% | 33% / 41% | 34% / 41% | 33% / 40% |
| Head angle away from the partner, mean | 9.1° / 8.7° | 9.2° / 8.5° | 9.2° / 8.7° | 9.3° / 9.0° |
| Head pitch against listening, mean | +0.4° / −2.2° | +0.3° / −2.0° | +0.9° / −1.7° | +0.6° / −2.0° |
| Head speed, mean, degrees per second | 20.4 / 18.0 | 22.3 / 18.3 | 18.5 / 16.1 | 18.3 / 15.9 |

**Resuming after a pause, timed on the first sound after it.** Head speed rises from 18.0 / 15.6 degrees per second at 0.3 s before to 24.7 / 19.8 at 0.2 s after. The pitch falls by about 0.9° / 0.8° between 0.7 s before and 0.3 s after.

**What these say.**
- **Bid.** The person about to speak looks away from the partner, starting about 1 s before the first word and fastest in the last 0.5 s. The head starts to move in the last 0.5 s, peaks just after the first word, and dips by about 1.3° / 2.4°.
- **Yield.** The eyes come back first, from about 0.7 s before the last sound, and keep returning through the silence. The head follows more slowly, mostly after the last sound. The head settles toward its listening speed over the next second.
- **Pause.** Nothing returns. The head slows by about 17% / 12% over the last 0.7 s, and the pitch rises by about 0.6° / 0.5°.
- **Sign of pitch.** Positive is read as chin up, from the study's own label "head_pitch (chin up)". It was not checked on video.
- **Averages against one body.** Each share is an average over people who look away and people who do not. A single head has to do one or the other.
- **Eye angles.** The tracks give iris position in eye widths. Degrees need an assumed eyeball size and would be approximate.
- **Length of glances.** While speaking, a look at the partner lasts a median 0.3 s and a look away 0.5 s / 0.4 s in these tracks. The study found that the on-or-off label flickers (46% of its changes on the Seamless test split are single-frame blips), so these lengths are too short and should not be used as measured.

---

## 4. Torso and hand (Seamless only)

1,013 persons in 540 conversations with body tracks: 3,252 bids, 3,240 turn ends, 14,232 pauses. Both signals are taken against the person's own median while listening.

**Levels.**

| | Listening | Speaking |
|---|---|---|
| Torso lean against listening, 10th to 90th percentile | −2.1° to +2.4° | −4.0° to +2.9° |
| Torso lean speed, median | 1.7 degrees per second | 3.3 degrees per second |
| Hand above its listening height, median and 75th, 90th percentile | 0.00, 0.03, 0.10 torso lengths | 0.11, 0.33, 0.50 torso lengths |
| Share of frames with a hand at least 0.10 torso lengths above listening height | 15% | 50% |
| Same, at least 0.25 torso lengths | 10% | 38% |

**Hand, around each event.** Share of frames with a hand at least 0.10 torso lengths above the person's listening height, and the 75th percentile of the rise.

| Event | 2 s before | 1 s before | 0.5 s before | At the event | 0.3 s after | 0.7 s after | 1 s after |
|---|---|---|---|---|---|---|---|
| Bid (first word): share | 18% | 18% | 19% | 25% | 33% | 38% | 38% |
| Bid: 75th percentile of the rise, torso lengths | 0.04 | 0.04 | 0.05 | 0.10 | 0.22 | 0.31 | 0.31 |
| Yield (last sound): share | 41% | 45% | 42% | 35% | 31% | 25% | 23% |
| Yield: 75th percentile of the rise, torso lengths | 0.34 | 0.38 | 0.35 | 0.25 | 0.19 | 0.10 | 0.08 |
| Pause (last sound before it): share | 50% | 53% | 53% | 51% | 50% | 46% | 42% |
| Pause: 75th percentile of the rise, torso lengths | 0.39 | 0.41 | 0.41 | 0.39 | 0.40 | 0.37 | 0.35 |

**Torso, around each event.** Mean lean against listening, degrees; positive is read as towards the partner.

| Event | 2 s before | 0.7 s before | At the event | 0.5 s after | 1 s after |
|---|---|---|---|---|---|
| Bid | +0.2 | +0.3 | −0.2 | −0.4 | −0.3 |
| Yield | −0.4 | −0.3 | +0.3 | +0.6 | +0.7 |
| Pause | −0.6 | −0.7 | −0.4 | −0.3 | +0.1 |

**What these say.**
- **The hand rises with the first words, not before them.** Half a second before the first word the share is still at its listening level (19%). It reaches 38% at 0.7 s after. The study's "hand lift from 0.5 s before" is the start of this rise.
- **About half of speakers have a hand up at any moment**, and a quarter of them have it at least 0.33 torso lengths above its listening height.
- **The hand comes down before the turn ends.** It starts to fall about 1 s before the last sound (45% to 35%) and is near its listening level 1 s after (23%).
- **The hand stays up through a pause.** 53% before, 50% at 0.3 s into it. It falls only in the long pauses that are still running after 0.7 s.
- **The torso leans very little.** About 0.5° away from the partner on starting to speak and about 1° back towards the partner through the yield. This is the same direction as the head's pitch and the gaze return.

---

## 5. Mouth (as reported by the study)

The mouth timings used by the profiles are taken from the study and were not measured again here. Values are Seamless / CANDOR.

| Situation | What the mouth does |
|---|---|
| A long utterance is coming | A quarter open 0.72 s / 0.83 s before the first word; half open 0.43 s before it on both corpora |
| A short reply | Half open 0.10 s / 0.14 s before the sound |
| A pause with more to come | The jaw dips, then stays half open for about the first second. In pauses longer than 1 s the mouth closes |
| Resuming after a pause of 2.5 s or more | Opens as early as at a turn start: half open 0.42 s / 0.30 s ahead |

The early opening announces a long utterance, not turn-taking as such: a speaker resuming after a long pause opens as early as one starting a turn. Such run-ups are often abandoned: 43% of them in the Seamless development set, at a detection setting that admits 10% false starts.

---

## 6. Not measured

- Shoulder and elbow angles, torso turn and tilt, and which arm moves.
- Any body movement on video calls.
- Whether a viewer reads these movements as the cues they stand for.
