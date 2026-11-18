"""TagService and ActionTagToRTVI: tag generators as a Pipecat stage, and their relay to clients.

``TagService`` is the sibling of ``MotionService`` in the pose-stream prototype, for generators that return timed
tags instead of poses.  It consumes each ``SpeechStepFrame``, checks that the speech context
has what the generator reads (the same ``check_context`` the motion stage uses) and pushes an
``ActionTagFrame`` for every tag.  Tag generators are cheap, so they run inline rather than on
a worker thread.

``ActionTagToRTVI`` is the sibling of that prototype's ``MotionToRTVI``: it turns each tag into an RTVI
server message, stamped with the bot's clock at the moment of sending (``now_ms``), which
lets a client relate the bot's clock to its own.  It also repeats the latest state once a
second, so that relation stays fresh between turns.
"""

from __future__ import annotations

import asyncio
import time

from loguru import logger
from pipecat.frames.frames import CancelFrame, EndFrame, Frame, StartFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.processors.frameworks.rtvi.frames import RTVIServerMessageFrame

from kinesics_core.frames import SpeechStepFrame
from kinesics_core.generator import check_context

from .frames import ActionTagFrame
from .generator import TurnCueGenerator
from .stage import default_clock


class TagService(FrameProcessor):
    def __init__(self, generator, **kwargs):
        super().__init__(**kwargs)
        self._gen = generator

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, SpeechStepFrame):
            check_context(self._gen, frame.step)   # a clear error if the stage does not feed this generator
            t0 = time.perf_counter()
            tags, _ = self._gen.step(frame.step)
            ms = (time.perf_counter() - t0) * 1000.0
            if ms > 5.0:
                logger.warning(f"{self}: a tag step took {ms:.1f} ms")
            for data in tags:
                await self.push_frame(ActionTagFrame(kind="turn", data=data))
            return   # consumed here
        if isinstance(frame, StartFrame):
            self._gen.reset()
        await self.push_frame(frame, direction)
        if isinstance(frame, (EndFrame, CancelFrame)):
            self._gen.close()


class ActionTagToRTVI(FrameProcessor):
    """``recorder``, if given, gets ``recorder.event("turn_cue", msg=...)`` for every message sent."""

    def __init__(self, *, clock=default_clock, recorder=None, heartbeat_s: float = 1.0, **kwargs):
        super().__init__(**kwargs)
        self._clock = clock
        self._recorder = recorder
        self._heartbeat_s = heartbeat_s
        # Before the first turn: an idle state with every field present, so the clock relation exists early.
        self._last: dict = TurnCueGenerator().state()
        self._task: asyncio.Task | None = None

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, ActionTagFrame):
            self._last = frame.data
            await self._send()
            return
        await self.push_frame(frame, direction)
        if isinstance(frame, StartFrame) and self._heartbeat_s > 0:
            self._task = self.create_task(self._heartbeat())
        elif isinstance(frame, (EndFrame, CancelFrame)) and self._task:
            await self.cancel_task(self._task)
            self._task = None

    async def _send(self, heartbeat: bool = False):
        msg = {**self._last, "now_ms": round(self._clock(), 1)}
        await self.push_frame(RTVIServerMessageFrame(data=msg))
        if self._recorder:
            self._recorder.event("turn_cue", heartbeat=heartbeat, msg=msg)

    async def _heartbeat(self):
        while True:
            await asyncio.sleep(self._heartbeat_s)
            await self._send(heartbeat=True)
