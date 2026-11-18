"""The turn-cue path: tap, cascaded speech stage, turn-cue generator and relay."""

import asyncio
import math

import numpy as np
from pipecat.frames.frames import (
    InterruptionFrame, LLMFullResponseEndFrame, LLMFullResponseStartFrame, LLMTextFrame,
    TTSAudioRawFrame, TTSStartedFrame, TTSStoppedFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.processors.frameworks.rtvi.frames import RTVIServerMessageFrame
from pipecat.frames.frames import SystemFrame

from kinesics_core.frames import SpeechStepFrame
from kinesics_core.generator import SpeechContext, SpeechStep, check_context
from kinesics_core.playout import AudioPlayout
from turncue import ActionTagToRTVI, CascadeSpeechStage, ReplyEvent, ReplyTextTap, TagService, TurnCueGenerator
from turncue.generator import FIRST_TEXT_TO_SOUND_MS, SPEECH_REQUEST_TO_SOUND_MS

RATE = 24000


def tone(ms, amp=8000.0):
    n = int(RATE * ms / 1000)
    return (amp * np.sin(2 * math.pi * 220 * np.arange(n) / RATE)).astype(np.int16)


def quiet(ms):
    return np.zeros(int(RATE * ms / 1000), np.int16)


def step(event, t, *, rid=7, text="", pcm=None, send_ms=None):
    ctx = SpeechContext(reply=ReplyEvent(rid, event, t, text), audio_send_ms=send_ms,
                        sample_rate=RATE if pcm is not None else None)
    return SpeechStep(pcm_out=pcm if pcm is not None else np.zeros(0, np.int16), context=ctx)


def feed_audio(gen, pcm, start_ms, piece_ms=40):
    """Feed ``pcm`` in pieces as a speech stage would; return every tag."""
    tags, n = [], int(RATE * piece_ms / 1000)
    for k in range(0, len(pcm), n):
        out, _ = gen.step(step("audio", start_ms, pcm=pcm[k:k + n], send_ms=start_ms + 1000 * k / RATE))
        tags += out
    return tags


# ---------------------------------------------------------------------- the generator alone

def test_a_reply_goes_from_preparing_to_ended_with_its_pause_and_end_known_ahead():
    gen = TurnCueGenerator()
    (t,), _ = gen.step(step("preparing", 100.0))
    assert t["status"] == "preparing" and t["turn"] == 1 and t["onset_ms"] is None
    (t,), _ = gen.step(step("first_text", 600.0, text="Hello"))
    assert t["text_started"] and t["onset_ms"] == 600.0 + FIRST_TEXT_TO_SOUND_MS and not t["onset_exact"]
    (t,), _ = gen.step(step("speech_requested", 700.0, text="Hello"))
    assert t["onset_ms"] == 700.0 + SPEECH_REQUEST_TO_SOUND_MS
    # 150 ms of quiet, 1 s of sound, 400 ms pause, 600 ms of sound, 200 ms of quiet, starting to leave at 1000 ms.
    audio = np.concatenate([quiet(150), tone(1000), quiet(400), tone(600), quiet(200)])
    tags = feed_audio(gen, audio, 1000.0)
    assert tags[0]["status"] == "speaking" and tags[0]["onset_exact"]
    assert abs(tags[0]["onset_ms"] - 1150.0) <= 10.0
    last = tags[-1]
    assert len(last["segments"]) == 2
    first, second = last["segments"]
    assert abs(first["end_ms"] - 2150.0) <= 10.0 and abs(second["start_ms"] - 2550.0) <= 10.0
    (t,), _ = gen.step(step("text_complete", 900.0, text="Hello there, how are you?"))
    assert t["words"] == 5
    (t,), _ = gen.step(step("speech_done", 1100.0))
    assert abs(t["end_ms"] - 3150.0) <= 10.0 and t["status"] == "speaking"
    (t,), _ = gen.step(step("stopped", 3300.0))
    assert t["status"] == "ended"
    revs = [x["rev"] for x in tags]
    assert revs == sorted(revs) and len(set(revs)) == len(revs)


def test_short_dips_inside_speech_are_not_pauses():
    gen = TurnCueGenerator()
    gen.step(step("preparing", 0.0))
    audio = np.concatenate([tone(300), quiet(80), tone(300)])
    tags = feed_audio(gen, audio, 0.0)
    gen.step(step("speech_done", 10.0))
    assert len(gen.segments) == 1


def test_an_interruption_before_any_sound_cancels_and_after_it_interrupts():
    gen = TurnCueGenerator()
    gen.step(step("preparing", 0.0))
    (t,), _ = gen.step(step("interrupted", 50.0))
    assert t["status"] == "cancelled"
    gen.step(step("preparing", 100.0, rid=8))
    feed_audio(gen, tone(2000), 200.0)
    (t,), _ = gen.step(step("interrupted", 1200.0, rid=8))
    assert t["status"] == "interrupted" and t["turn"] == 2 and abs(t["end_ms"] - 1200.0) <= 10.0
    # Nothing more happens to a finished turn.
    assert gen.step(step("speech_done", 1300.0, rid=8))[0] == []


def test_the_motion_stage_contract_refuses_a_context_without_the_reply():
    gen = TurnCueGenerator()
    moshi_like = SpeechStep(pcm_out=np.zeros(1920, np.int16), context=SpeechContext(agent_tokens=np.zeros((1, 9, 1))))
    try:
        check_context(gen, moshi_like)
    except ValueError as e:
        assert "reply" in str(e)
    else:
        raise AssertionError("a context without 'reply' was accepted")


# ---------------------------------------------------------------------- as a pipeline

class FakeTTS(FrameProcessor):
    """Stands in for a text-to-speech service the way Pipecat's behaves: it consumes the text,
    passes system frames on at once, and emits audio for the whole reply once its text is complete."""

    def __init__(self, audio, **kw):
        super().__init__(**kw)
        self.audio = audio
        self.seen_text = []

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMTextFrame):
            self.seen_text.append(frame.text)
            return
        await self.push_frame(frame, direction)
        if isinstance(frame, LLMFullResponseEndFrame):
            await asyncio.sleep(0.05)
            await self.push_frame(TTSStartedFrame())
            n = int(RATE * 0.04)
            for k in range(0, len(self.audio), n):
                await self.push_frame(TTSAudioRawFrame(audio=self.audio[k:k + n].tobytes(), sample_rate=RATE, num_channels=1))
            await self.push_frame(TTSStoppedFrame())


class Sink(FrameProcessor):
    def __init__(self, **kw):
        super().__init__(**kw)
        self.messages, self.leaked = [], []

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, RTVIServerMessageFrame):
            self.messages.append(frame.data)
        elif isinstance(frame, SpeechStepFrame) or type(frame).__name__ in ("ReplyTextFrame", "ActionTagFrame"):
            self.leaked.append(frame)
        await self.push_frame(frame, direction)


def test_the_path_reports_the_reply_through_a_text_to_speech_stage_and_an_interruption():
    audio = np.concatenate([quiet(100), tone(600), quiet(300), tone(400)])
    tts, sink = FakeTTS(audio), Sink()
    playout = AudioPlayout()
    playout.begin()   # nothing is ever sent here, so every piece waits behind the ones before it
    stage = CascadeSpeechStage(playout)
    pipeline = Pipeline([ReplyTextTap(), tts, stage, TagService(TurnCueGenerator()), ActionTagToRTVI(heartbeat_s=0), sink])

    async def run():
        task = PipelineTask(pipeline, params=PipelineParams())
        runner = asyncio.create_task(PipelineRunner(handle_sigint=False).run(task))
        await asyncio.sleep(0.2)
        await task.queue_frames([LLMFullResponseStartFrame(), LLMTextFrame("Hello "), LLMTextFrame("there."),
                                 LLMFullResponseEndFrame()])
        await asyncio.sleep(0.5)
        await task.queue_frames([InterruptionFrame()])
        await asyncio.sleep(0.3)
        await task.cancel()
        await runner

    asyncio.run(run())
    statuses = [m["status"] for m in sink.messages]
    assert tts.seen_text == ["Hello ", "there."]           # the text-to-speech stage got all the text
    assert not sink.leaked                                    # internal frames never reach the transport
    assert statuses[0] == "preparing" and sink.messages[1]["text_started"]
    assert "speaking" in statuses
    speaking = [m for m in sink.messages if m["status"] == "speaking"]
    assert any(m["end_ms"] is not None and len(m["segments"]) == 2 for m in speaking)
    assert statuses[-1] == "interrupted"
    assert all("now_ms" in m for m in sink.messages)
