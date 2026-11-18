"""The two processors that turn a cascaded bot's speech into speech contexts.

    llm -> ReplyTextTap -> tts -> CascadeSpeechStage -> (a tag or motion stage) -> ...

:class:`ReplyTextTap` sits between the language model and the text-to-speech service.  It
passes every frame on unchanged and reports what it sees of each reply: that it started,
its first text, its whole text.  The text-to-speech service consumes that text, so nothing
after it can see it (Pipecat 1.12 sets ``push_text_frames=False`` for services with word
timestamps, Cartesia among them).

:class:`CascadeSpeechStage` sits right after the text-to-speech service.  It passes the audio
on first, then pushes a ``SpeechStepFrame`` for every piece of audio and every event of the
reply, with the cascaded fields of the ``SpeechContext`` filled.  It is to a cascaded bot what
``DuplexSpeechService`` is to the full-duplex one: the stage a motion or tag generator reads.

Times.  Everything is in milliseconds on one clock, ``clock()``, chosen by the bot.  When the
first sample of a piece of audio leaves the server is known before it leaves: the output
transport sends in real time, so it is now plus the audio already waiting in its queue, which
``kinesics_core.playout.AudioPlayout`` measures.
"""

from __future__ import annotations

import time

import numpy as np
from pipecat.frames.frames import (
    BotStoppedSpeakingFrame,
    Frame,
    InterruptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
    TTSTextFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from kinesics_core.frames import SpeechStepFrame
from kinesics_core.generator import SpeechContext, SpeechStep

from .frames import ReplyEvent, ReplyTextFrame

_T0 = time.perf_counter()


def default_clock() -> float:
    """Milliseconds since this module was loaded, on a monotonic clock."""
    return (time.perf_counter() - _T0) * 1000.0


class ReplyTextTap(FrameProcessor):
    """Passes everything on; reports each reply's start, first text and whole text downstream."""

    def __init__(self, *, clock=default_clock, **kwargs):
        super().__init__(**kwargs)
        self._clock = clock
        self._reply_id: int | None = None
        self._text = ""

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)
        if direction != FrameDirection.DOWNSTREAM:
            return
        if isinstance(frame, LLMFullResponseStartFrame):
            self._reply_id, self._text = frame.id, ""
            await self._report("preparing")
        elif isinstance(frame, LLMTextFrame) and self._reply_id is not None:
            first = not self._text
            self._text += frame.text
            if first and frame.text.strip():
                await self._report("first_text")
            elif first:
                self._text = ""  # leading whitespace is not text yet
        elif isinstance(frame, LLMFullResponseEndFrame) and self._reply_id is not None:
            await self._report("text_complete")
            self._reply_id = None

    async def _report(self, event: str):
        await self.push_frame(ReplyTextFrame(reply=ReplyEvent(self._reply_id, event, self._clock(), self._text)))


class CascadeSpeechStage(FrameProcessor):
    """Builds the speech contexts of a cascaded bot from the text-to-speech service's output.

    ``playout`` is the ``AudioPlayout`` that a ``PlayoutObserver`` on the output transport keeps
    up to date; this stage tells it about the audio it hands over.
    """

    def __init__(self, playout, *, clock=default_clock, **kwargs):
        super().__init__(**kwargs)
        self._playout = playout
        self._clock = clock
        self._reply_id = 0          # the reply the audio belongs to, in the order the audio arrives
        self._text: dict[int, str] = {}
        self._seq = 0

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, ReplyTextFrame):
            # From the tap; consumed here.  It can overtake the reply's own frames.
            r = frame.reply
            self._text[r.reply_id] = r.text
            await self._step(r)
            return

        await self.push_frame(frame, direction)   # everything else passes on first, audio included

        if isinstance(frame, BotStoppedSpeakingFrame):
            # The output transport sends this both ways; the upstream copy is the one that reaches us.
            if direction == FrameDirection.UPSTREAM:
                await self._event("stopped")
            return
        if direction != FrameDirection.DOWNSTREAM:
            return
        if isinstance(frame, LLMFullResponseStartFrame):
            self._reply_id = frame.id
        elif isinstance(frame, TTSStartedFrame):
            await self._event("speech_requested")
        elif isinstance(frame, TTSAudioRawFrame):
            send_ms = self._clock() + self._playout.queued_ms
            self._playout.handed(len(frame.audio))
            pcm = np.frombuffer(frame.audio, dtype=np.int16)
            if frame.num_channels > 1:
                pcm = pcm[:: frame.num_channels]
            await self._event("audio", pcm=pcm, audio_send_ms=send_ms, sample_rate=frame.sample_rate)
        elif isinstance(frame, TTSTextFrame) and frame.pts:
            # Pipecat's word time is on the pipeline clock; carry it over to ours.
            ahead_ms = (frame.pts - self.get_clock().get_time()) / 1e6
            await self._event("words", words=[(frame.text, self._clock() + ahead_ms)])
        elif isinstance(frame, TTSStoppedFrame):
            await self._event("speech_done")
        elif isinstance(frame, InterruptionFrame):
            # The output transport drops the audio it holds; so does our count of it.
            self._playout.flush()
            await self._event("interrupted")

    async def _event(self, event: str, *, pcm=None, audio_send_ms=None, sample_rate=None, words=None):
        reply = ReplyEvent(self._reply_id, event, self._clock(), self._text.get(self._reply_id, ""))
        await self._step(reply, pcm=pcm, audio_send_ms=audio_send_ms, sample_rate=sample_rate, words=words)

    async def _step(self, reply: ReplyEvent, *, pcm=None, audio_send_ms=None, sample_rate=None, words=None):
        self._seq += 1
        context = SpeechContext(reply=reply, audio_send_ms=audio_send_ms, sample_rate=sample_rate, words=words)
        step = SpeechStep(
            pcm_out=pcm if pcm is not None else np.zeros(0, np.int16),
            context=context,
            speaking=reply.event == "audio",
            interrupted=reply.event == "interrupted",
            text=" ".join(w for w, _ in words) if words else None,
        )
        await self.push_frame(SpeechStepFrame(step=step, pts_ms=int(audio_send_ms or reply.t_ms), seq=self._seq,
                                              started=time.perf_counter()))
