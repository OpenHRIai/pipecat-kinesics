"""Generator interface and the synthetic (GPU-free) implementation.

A *duplex generator* is stepped once per 80 ms of user audio (1920 samples at
24 kHz) and returns 80 ms of agent audio plus two 25 fps pose frames for the
same interval.  Motion and audio therefore share one timeline at the source;
synchronisation downstream is purely a buffering problem.

Implementations:

* :class:`SyntheticDuplexGenerator` (this module): an energy VAD on the user's
  audio, scripted tone "utterances" as the agent's speech, and procedural
  gestures whose beats, head nods and jaw opening are locked to that audio.
  Runs anywhere; used to verify transport, sync and rendering on a laptop.
* A generator backed by a full-duplex speech model and a gesture model implements the
  same interface; none is included in this repository.
"""

from __future__ import annotations

import math
import random
import time
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

import numpy as np

from .rig import J, N_EXPR, N_JOINTS, PoseFrames, axis_angle_to_quat

SAMPLE_RATE = 24000
STEP_SAMPLES = 1920  # 80 ms, one frame of a 12.5 Hz speech codec
POSES_PER_STEP = 2  # 25 fps motion, 12.5 Hz steps
POSE_DT_MS = 40


@dataclass
class StepResult:
    """Output of one 80 ms generator step."""

    pcm_out: np.ndarray  # int16, shape (1920,)
    poses: PoseFrames  # 2 pose frames
    speaking: bool = False
    interrupted: bool = False
    text: str | None = None  # transcript piece, if the model produced one
    timings_ms: dict = field(default_factory=dict)


@runtime_checkable
class DuplexGenerator(Protocol):
    """Full-duplex speech + motion model behind a single step() call."""

    sample_rate: int
    step_samples: int
    poses_per_step: int

    def reset(self) -> None:
        """Start a new conversation (clear all streaming state)."""

    def step(self, pcm_in: np.ndarray) -> StepResult:
        """Consume 1920 int16 samples of user audio, produce the next 80 ms."""

    def on_client_message(self, msg_type: str, data) -> None:
        """Custom client -> server message (used by the sync probe's ``ping``)."""

    def close(self) -> None:
        """Release resources."""


# --------------------------------------------------------------------------------------
# The same step, split in two: speech first, then motion
# --------------------------------------------------------------------------------------
#
# The pipeline runs speech and motion as two stages (a speech stage and a reading stage).  The speech
# model produces the agent's audio and a :class:`SpeechContext`: what a motion model
# may read for that step.  The motion model turns each context into poses.  Because
# the two are separate, the audio can leave as soon as it exists.

CONTEXT_VERSION = 1


@dataclass
class SpeechContext:
    """What the speech model hands the motion model for one 80 ms step.

    This is the contract between the two stages, and the input format a motion
    model is trained against.  Change a field's meaning or shape and
    ``CONTEXT_VERSION`` must change with it.

    The arrays are framework tensors that stay on the speech model's device (for
    a neural speech model, tensors on the GPU), so both stages must run in one process.
    Shapes use B = 1 session, K = 8 audio codebooks per stream, T = 1 step.

    Two kinds of speech stage fill it, each its own fields.  A motion model names
    the fields it reads (``requires``); the motion stage refuses a context that
    lacks one, so a model can only be paired with a speech stage that feeds it.

    * A full-duplex speech stage (not in this repository) fills
      ``agent_tokens`` and ``user_audio_tokens``, one context per 80 ms step.
    * The cascaded speech stage (``turncue/stage.py``, after any Pipecat
      text-to-speech service) fills ``reply``, ``audio_send_ms`` and ``words``,
      one context per piece of synthesized audio or per event of the reply.
      Its audio is the step's ``pcm_out``.

    Parameters:
        agent_tokens: Integer tensor (B, 1 + K, T).  Row 0 is the text token the
            speech model emitted this step; rows 1..K are the audio tokens of the
            agent's own voice for the same step.
        user_audio_tokens: Integer tensor (B, K, T), or None.  The user's
            microphone audio for this step as codec tokens.  A motion model that
            reacts to the partner needs it.
        hidden: Optional dict, layer name -> float tensor (B, T, D), holding the
            speech model's hidden states for this step.  Not captured yet: it is
            the slot for our own motion model, which is designed to read them.
        reply: The reply this step belongs to and what just happened to it
            (:class:`turncue.frames.ReplyEvent`).  Cascaded speech stage only.
        audio_send_ms: When the first sample of this step's ``pcm_out`` leaves the
            server, in milliseconds on the bot's clock.  Cascaded only.
        sample_rate: Sample rate of ``pcm_out``.  Cascaded only (a full-duplex model's is fixed).
        words: Words of the reply whose time became known in this step, as
            ``(word, send_ms)`` pairs: when the word's audio leaves the server,
            from the text-to-speech service's own word timestamps.  Cascaded only.
        version: ``CONTEXT_VERSION`` at the time the context was built.
    """

    agent_tokens: object = None
    user_audio_tokens: object = None
    hidden: dict | None = None
    reply: object = None
    audio_send_ms: float | None = None
    sample_rate: int | None = None
    words: list | None = None
    version: int = CONTEXT_VERSION

    def shapes(self) -> dict:
        """Field name -> shape, for logs and reports (None for absent fields)."""
        shape = lambda x: None if x is None else tuple(int(n) for n in x.shape)  # noqa: E731
        out = {
            "version": self.version,
            "agent_tokens": shape(self.agent_tokens),
            "user_audio_tokens": shape(self.user_audio_tokens),
            "hidden": None if self.hidden is None else {k: shape(v) for k, v in self.hidden.items()},
        }
        # The cascaded fields are listed only when a cascaded speech stage filled them.
        if self.reply is not None:
            out["reply"] = getattr(self.reply, "event", "?")
            out["audio_send_ms"] = self.audio_send_ms
            out["words"] = None if self.words is None else len(self.words)
        return out


@dataclass
class SpeechStep:
    """What the speech model produced in one 80 ms step."""

    pcm_out: np.ndarray  # int16, shape (1920,)
    # None while the speech model has nothing to say about this step yet (a speech model's
    # first steps); the motion model then repeats its last poses.
    context: SpeechContext | None = None
    # Only for generators that compute speech and motion in one call, such as the
    # synthetic one: the finished poses, passed through to the motion stage.
    poses: PoseFrames | None = None
    speaking: bool = False
    interrupted: bool = False
    text: str | None = None
    timings_ms: dict = field(default_factory=dict)


@runtime_checkable
class SpeechGenerator(Protocol):
    """A full-duplex speech model: hears 80 ms, says 80 ms, every step."""

    sample_rate: int
    step_samples: int

    def reset(self) -> None: ...

    def step(self, pcm_in: np.ndarray) -> SpeechStep: ...

    def on_client_message(self, msg_type: str, data) -> None: ...

    def close(self) -> None: ...


@runtime_checkable
class MotionGenerator(Protocol):
    """A motion model driven by the speech model's output, one step at a time, in order."""

    poses_per_step: int
    requires: tuple[str, ...]  # the SpeechContext fields this model reads, e.g. ("agent_tokens",)

    def reset(self) -> None: ...

    def step(self, speech: SpeechStep) -> tuple[PoseFrames, dict]:
        """Poses for the same 80 ms as ``speech``, and timings in milliseconds."""

    def close(self) -> None: ...


def check_context(motion: MotionGenerator, speech: SpeechStep) -> None:
    """Fail with a clear message if ``speech`` lacks what ``motion`` says it reads.

    Without this, a speech model and a motion model that do not fit together fail
    somewhere deep inside the motion model, or worse, run on the wrong input.
    """
    ctx = speech.context
    if ctx is None:
        return  # nothing to read this step; the motion model repeats its last poses
    if ctx.version != CONTEXT_VERSION:
        raise ValueError(f"speech context is version {ctx.version}; this code expects {CONTEXT_VERSION}")
    missing = [f for f in getattr(motion, "requires", ()) if getattr(ctx, f, None) is None]
    if missing:
        raise ValueError(f"{type(motion).__name__} reads {missing} from the speech context, "
                         f"but the speech model did not provide it (it provided {ctx.shapes()})")


def combined_step(speech: SpeechGenerator, motion: MotionGenerator, pcm_in: np.ndarray) -> StepResult:
    """One speech step followed by its motion step, in series (offline tools and tests)."""
    t0 = time.perf_counter()
    s = speech.step(pcm_in)
    check_context(motion, s)
    poses, motion_timings = motion.step(s)
    timings = {**s.timings_ms, **motion_timings, "gen_ms": (time.perf_counter() - t0) * 1000.0}
    return StepResult(pcm_out=s.pcm_out, poses=poses, speaking=s.speaking, interrupted=s.interrupted,
                      text=s.text, timings_ms=timings)


class _CombinedAsSpeech:
    """Speech half of a generator that computes speech and motion in one call.

    It runs the whole combined step and passes the finished poses along in
    ``SpeechStep.poses``.  There is no speech context: nothing reads one.
    """

    def __init__(self, gen: DuplexGenerator):
        self._gen = gen
        self.sample_rate, self.step_samples = gen.sample_rate, gen.step_samples

    def reset(self) -> None:
        self._gen.reset()

    def step(self, pcm_in: np.ndarray) -> SpeechStep:
        r = self._gen.step(pcm_in)
        return SpeechStep(pcm_out=r.pcm_out, poses=r.poses, speaking=r.speaking, interrupted=r.interrupted,
                          text=r.text, timings_ms={"speech_ms": r.timings_ms.get("speech_ms", 0.0),
                                                   "_motion_ms": r.timings_ms.get("motion_ms", 0.0)})

    def on_client_message(self, msg_type: str, data) -> None:
        self._gen.on_client_message(msg_type, data)

    def close(self) -> None:
        self._gen.close()


class _PrecomputedMotion:
    """Motion half of a combined generator: the poses arrive ready in ``SpeechStep.poses``."""

    requires = ()  # reads nothing from the speech context

    def __init__(self, gen: DuplexGenerator):
        self.poses_per_step = gen.poses_per_step

    def reset(self) -> None:
        pass

    def step(self, speech: SpeechStep) -> tuple[PoseFrames, dict]:
        return speech.poses, {"motion_ms": speech.timings_ms.get("_motion_ms", 0.0)}

    def close(self) -> None:
        pass


def split_combined(gen: DuplexGenerator) -> tuple[SpeechGenerator, MotionGenerator]:
    """Present a one-call generator, such as the synthetic one, as a speech half and a motion half."""
    return _CombinedAsSpeech(gen), _PrecomputedMotion(gen)


# --------------------------------------------------------------------------------------
# Synthetic generator
# --------------------------------------------------------------------------------------

_PENTATONIC_HZ = [220.0, 246.9, 261.6, 293.7, 329.6, 392.0, 440.0]


@dataclass
class _Syllable:
    onset: float  # seconds on the output timeline
    dur: float
    hz: float


@dataclass
class _Utterance:
    start: float
    syllables: list[_Syllable]
    end: float  # last release finished
    cut_at: float | None = None  # barge-in: forced end


class SyntheticDuplexGenerator:
    """Scripted agent for exercising the pipeline without a GPU.

    Behaviour:
      * 1 s after reset the agent "greets" (an utterance), so motion is visible
        without a microphone.
      * After the user speaks for >= 300 ms and then falls silent for
        ``reply_after_s``, the agent replies with an utterance.
      * If the user speaks for >= 240 ms while the agent is talking, the agent
        stops (``interrupted`` flag).
      * A client ``ping`` message starts an utterance at the next step, which
        lets the web client measure end-to-end response latency without a mic.

    Motion is procedural: idle breathing/sway, and while speaking a right-arm
    beat gesture, head nods and finger curls driven by the syllable onsets, and
    a jaw opening equal to the audio envelope.  Because jaw == envelope, the
    client's cross-correlation probe can measure audio/motion lag directly.
    """

    sample_rate = SAMPLE_RATE
    step_samples = STEP_SAMPLES
    poses_per_step = POSES_PER_STEP

    def __init__(
        self,
        *,
        reply_after_s: float = 0.5,
        greet_after_s: float = 1.0,
        vad_threshold: float = 0.015,
        gain: float = 0.3,
        seed: int | None = 7,
    ):
        self.reply_after_s = reply_after_s
        self.greet_after_s = greet_after_s
        self.vad_threshold = vad_threshold
        self.gain = gain
        self._rng = random.Random(seed)
        self.reset()

    # ----- lifecycle -----
    def reset(self) -> None:
        self._t_samples = 0  # output samples emitted so far
        self._utt: _Utterance | None = None
        self._pending_utterance = False
        self._user_speaking = False
        self._user_speech_s = 0.0
        self._user_silence_s = 0.0
        self._user_spoke_since_reply = False
        self._greeted = False
        self._interrupt_steps = 0
        self._speak_gain = 0.0  # smoothed 0..1 blend between idle and gesture pose

    def close(self) -> None:
        pass

    def on_client_message(self, msg_type: str, data) -> None:
        if msg_type == "ping":
            self._pending_utterance = True

    # ----- helpers -----
    @property
    def t_now(self) -> float:
        return self._t_samples / self.sample_rate

    def _new_utterance(self, start: float) -> _Utterance:
        n = self._rng.randint(6, 10)
        syl = []
        t = start + 0.05
        for _ in range(n):
            syl.append(_Syllable(onset=t, dur=0.14, hz=self._rng.choice(_PENTATONIC_HZ)))
            t += 0.25 + self._rng.uniform(-0.03, 0.03)
        end = syl[-1].onset + syl[-1].dur + 0.05
        return _Utterance(start=start, syllables=syl, end=end)

    @staticmethod
    def _env(t: np.ndarray, onset: float, dur: float) -> np.ndarray:
        """Raised-cosine attack (15 ms) / release (40 ms) envelope, 0..1."""
        x = t - onset
        a, r = 0.015, 0.040
        att = np.clip(x / a, 0.0, 1.0)
        att = 0.5 - 0.5 * np.cos(np.pi * att)
        rel = np.clip((dur - x) / r, 0.0, 1.0)
        rel = 0.5 - 0.5 * np.cos(np.pi * rel)
        return np.where((x >= 0) & (x <= dur), att * rel, 0.0)

    def _audio_and_envelope(self, t0: float) -> tuple[np.ndarray, np.ndarray]:
        n = self.step_samples
        t = t0 + np.arange(n) / self.sample_rate
        audio = np.zeros(n, np.float64)
        env_total = np.zeros(n, np.float64)
        u = self._utt
        if u is not None:
            for s in u.syllables:
                if s.onset > t[-1] or s.onset + s.dur < t[0]:
                    continue
                e = self._env(t, s.onset, s.dur)
                if u.cut_at is not None:  # hard fade after a barge-in
                    e = e * np.clip(1.0 - (t - u.cut_at) / 0.05, 0.0, 1.0)
                env_total = np.maximum(env_total, e)
                # a little harmonic content so it is not a pure sine
                audio += e * (np.sin(2 * np.pi * s.hz * t) + 0.3 * np.sin(2 * np.pi * 2 * s.hz * t))
        return audio * self.gain, env_total

    def _beat(self, tau: float) -> float:
        """Exponentially decaying beat impulse from the most recent syllable onset."""
        u = self._utt
        if u is None:
            return 0.0
        b = 0.0
        for s in u.syllables:
            if s.onset <= tau:
                b = max(b, math.exp(-(tau - s.onset) / 0.12))
        if u.cut_at is not None and tau > u.cut_at:
            b *= max(0.0, 1.0 - (tau - u.cut_at) / 0.2)
        return b

    def _pose(self, tau: float, jaw_open: float, g: float) -> np.ndarray:
        """Axis-angle (55, 3) for time ``tau`` with speaking blend ``g`` in [0, 1]."""
        aa = np.zeros((N_JOINTS, 3), np.float64)
        two_pi = 2 * math.pi
        # --- idle layer ---
        aa[J["spine1"], 0] = 0.02 * math.sin(two_pi * 0.25 * tau)  # breathing
        aa[J["spine2"], 0] = 0.01 * math.sin(two_pi * 0.25 * tau + 0.4)
        aa[J["pelvis"], 1] = 0.04 * math.sin(two_pi * 0.08 * tau)  # slow sway (yaw)
        aa[J["head"], 1] = 0.10 * math.sin(two_pi * 0.07 * tau + 1.0)
        aa[J["head"], 0] = 0.03 * math.sin(two_pi * 0.13 * tau)
        # arms hang: rotate the T-pose arms down about Z, slightly away from the body
        hang = math.radians(68.0) + 0.02 * math.sin(two_pi * 0.25 * tau)
        aa[J["left_shoulder"], 2] = -hang
        aa[J["right_shoulder"], 2] = +hang
        # elbows slightly bent (about the local axis that folds the forearm forward)
        aa[J["left_elbow"], 1] = -0.25
        aa[J["right_elbow"], 1] = +0.25
        # legs: tiny weight shift
        aa[J["left_hip"], 2] = 0.02 * math.sin(two_pi * 0.08 * tau)
        aa[J["right_hip"], 2] = 0.02 * math.sin(two_pi * 0.08 * tau)
        # relaxed fingers
        for name in J:
            if ("index" in name or "middle" in name or "ring" in name or "pinky" in name) and "left" in name:
                aa[J[name], 2] = -0.25
            elif ("index" in name or "middle" in name or "ring" in name or "pinky" in name) and "right" in name:
                aa[J[name], 2] = +0.25
        # --- gesture layer (blended by g) ---
        if g > 0.0:
            b = self._beat(tau)
            ges = np.zeros_like(aa)
            # right arm comes up and forward, forearm beats on syllables
            ges[J["right_shoulder"], 2] = -math.radians(35.0)  # less hang -> arm raised
            ges[J["right_shoulder"], 1] = -math.radians(25.0)  # swing forward
            ges[J["right_elbow"], 1] = +math.radians(45.0 + 30.0 * b)
            ges[J["right_elbow"], 2] = +math.radians(10.0 * b)
            ges[J["right_wrist"], 0] = math.radians(15.0 * b)
            # left arm: sympathetic smaller motion
            ges[J["left_shoulder"], 2] = +math.radians(12.0)
            ges[J["left_elbow"], 1] = -math.radians(20.0 + 10.0 * b)
            # torso and head
            ges[J["spine3"], 0] = -math.radians(3.0 * b)
            ges[J["head"], 0] = -math.radians(6.0 * b)
            ges[J["neck"], 0] = -math.radians(2.0 * b)
            # fingers open on the beat
            for name in J:
                if "right_" in name and any(k in name for k in ("index", "middle", "ring", "pinky")):
                    ges[J[name], 2] = -0.25 * b
            aa += g * ges
        # jaw: opens with the audio envelope (rotation about X, mouth opens downward)
        aa[J["jaw"], 0] = math.radians(18.0) * jaw_open
        return aa

    # ----- main step -----
    def step(self, pcm_in: np.ndarray) -> StepResult:
        t_wall = time.perf_counter()
        pcm_in = np.asarray(pcm_in, dtype=np.int16)
        assert pcm_in.shape == (self.step_samples,), pcm_in.shape
        step_s = self.step_samples / self.sample_rate
        t0 = self.t_now

        # --- user VAD (energy) ---
        rms = float(np.sqrt(np.mean((pcm_in.astype(np.float32) / 32768.0) ** 2)))
        voiced = rms > self.vad_threshold
        if voiced:
            self._user_speech_s += step_s
            self._user_silence_s = 0.0
            if self._user_speech_s >= 0.3:
                self._user_spoke_since_reply = True
        else:
            self._user_silence_s += step_s
            if self._user_silence_s > 0.3:
                self._user_speech_s = 0.0

        interrupted = False
        u = self._utt
        speaking = u is not None and u.cut_at is None and t0 < u.end

        # --- barge-in ---
        if speaking and voiced:
            self._interrupt_steps += 1
            if self._interrupt_steps >= 3 and u.cut_at is None:
                u.cut_at = t0
                interrupted = True
        else:
            self._interrupt_steps = 0

        # --- decide to start an utterance ---
        if u is not None and t0 >= u.end + 0.1:
            self._utt = u = None
        if u is None:
            start = False
            if not self._greeted and t0 >= self.greet_after_s:
                self._greeted = True
                start = True
            elif self._pending_utterance:
                start = True
            elif (
                self._user_spoke_since_reply
                and not voiced
                and self._user_silence_s >= self.reply_after_s
            ):
                start = True
            if start:
                self._pending_utterance = False
                self._user_spoke_since_reply = False
                self._utt = u = self._new_utterance(t0)
        speaking = u is not None and u.cut_at is None and t0 < u.end

        # --- audio ---
        t_speech0 = time.perf_counter()
        audio, env = self._audio_and_envelope(t0)
        pcm_out = np.clip(audio * 32767.0, -32768, 32767).astype(np.int16)
        t_speech = (time.perf_counter() - t_speech0) * 1000.0

        # --- motion: two frames at t0 and t0 + 40 ms ---
        t_motion0 = time.perf_counter()
        target_gain = 1.0 if speaking else 0.0
        quats = np.zeros((self.poses_per_step, N_JOINTS, 4), np.float32)
        half = self.step_samples // self.poses_per_step
        for k in range(self.poses_per_step):
            tau = t0 + k * POSE_DT_MS / 1000.0
            # smooth the idle<->gesture blend: ~300 ms rise, ~500 ms fall
            rate = 0.040 / 0.3 if target_gain > self._speak_gain else 0.040 / 0.5
            self._speak_gain += np.clip(target_gain - self._speak_gain, -rate, rate)
            jaw_open = float(env[k * half : (k + 1) * half].max()) if env.size else 0.0
            quats[k] = axis_angle_to_quat(self._pose(tau, jaw_open, float(self._speak_gain)))
        expr = np.zeros((self.poses_per_step, N_EXPR), np.float32)
        # expression slot 0 carries the mouth-open amount so the face path is non-trivial
        for k in range(self.poses_per_step):
            expr[k, 0] = float(env[k * half : (k + 1) * half].max()) if env.size else 0.0
        transl = np.zeros((self.poses_per_step, 3), np.float32)
        transl[:, 1] = 0.95 + 0.004 * math.sin(2 * math.pi * 0.25 * t0)
        poses = PoseFrames(quats, expr, transl)
        t_motion = (time.perf_counter() - t_motion0) * 1000.0

        self._t_samples += self.step_samples
        return StepResult(
            pcm_out=pcm_out,
            poses=poses,
            speaking=speaking,
            interrupted=interrupted,
            timings_ms={
                "speech_ms": t_speech,
                "motion_ms": t_motion,
                "gen_ms": (time.perf_counter() - t_wall) * 1000.0,
            },
        )
