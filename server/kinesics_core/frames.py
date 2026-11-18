"""MotionFrame: body motion as a first-class Pipecat frame.  SpeechStepFrame: what the motion stage reads."""

from __future__ import annotations

from dataclasses import dataclass, field

from pipecat.frames.frames import DataFrame

from .generator import SpeechStep
from .rig import PoseFrames


@dataclass
class MotionFrame(DataFrame):
    """A short run of pose frames aligned to the agent's output audio.

    Parameters:
        poses: ``n`` pose frames (25 fps), see :class:`kinesics_core.rig.PoseFrames`.
        pts_ms: Position of ``poses[0]`` on the agent's output-audio timeline,
            i.e. output samples emitted before this step / 24.  The companion
            :class:`OutputAudioRawFrame` for the same step starts at this pts.
        dt_ms: Spacing between consecutive pose frames (40 ms at 25 fps).
        seq: Monotonic step counter within the session.
        speaking: Generator's own estimate that the agent is speaking.
        interrupted: The agent was cut off during this step (barge-in).
        stats: Optional per-step timings (``speech_ms``, ``motion_ms``, ...).
    """

    poses: PoseFrames
    pts_ms: int
    dt_ms: int = 40
    seq: int = 0
    speaking: bool = False
    interrupted: bool = False
    stats: dict = field(default_factory=dict)

    def __str__(self):
        return (
            f"{self.name}(seq: {self.seq}, pts_ms: {self.pts_ms}, n: {self.poses.n}, "
            f"speaking: {self.speaking})"
        )


@dataclass
class SpeechStepFrame(DataFrame):
    """One step of the speech model's output, on its way to the motion stage.

    The speech stage pushes one of these right after the :class:`OutputAudioRawFrame`
    for the same 80 ms.  The motion stage consumes it and replaces it with a
    :class:`MotionFrame`; it never reaches the transport.

    Parameters:
        step: The speech model's output, including the :class:`SpeechContext` the
            motion model reads (see kinesics_core/generator.py for its fields).
        pts_ms: Position of this step on the agent's output-audio timeline.
        seq: Monotonic step counter within the session.
        started: ``time.perf_counter()`` when the speech step began, so the motion
            stage can report how long the whole step took.
        stats: The speech stage's timings and queue counters for this step.
    """

    step: SpeechStep = None
    pts_ms: int = 0
    seq: int = 0
    started: float = 0.0
    stats: dict = field(default_factory=dict)

    def __str__(self):
        return f"{self.name}(seq: {self.seq}, pts_ms: {self.pts_ms})"
