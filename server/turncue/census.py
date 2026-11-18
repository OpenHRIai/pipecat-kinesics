"""Timing census of a cascaded bot: when does the server know what, against when the audio leaves.

This records, for every reply of a live session, the moment each
candidate hook fires (the reply starts being prepared, its first audio is
queued, its text is complete, its last audio is queued) and the moment each
piece of audio is sent.  The differences are the leads a robot client could
have for its bid and yield cues.

Nothing here changes the pipeline.  :class:`CensusObserver` is a Pipecat
observer: it is told about every frame any processor pushes, and writes the
ones that matter to the recorder.

One folder per session, named by its start time in UTC:

  session.json   what ran, the sample rates, the start time as wall clock
  events.jsonl   one line per event: ``{"t_ms", "ev", ...}``.  ``t_ms`` is milliseconds
                 since the session started on the server's monotonic clock; ``clock_ns``
                 is Pipecat's pipeline clock at the same moment, the clock that word
                 time stamps (``pts_ns``) are given on
  agent.wav      the agent's audio as sent, laid on the send clock: the sample at
                 position p left the server p seconds after the session started
  user.wav       the microphone audio as it arrived, laid on the same clock
  client.jsonl   the page's reports: when standard RTVI messages arrived there, when the
                 agent's audio became audible there, and the browser's network statistics
"""

from __future__ import annotations

import json
import time
import wave
from pathlib import Path

from pipecat.frames.frames import InputAudioRawFrame, OutputAudioRawFrame
from pipecat.observers.base_observer import BaseObserver, FramePushed
from pipecat.processors.frame_processor import FrameDirection
from pipecat.processors.frameworks.rtvi.frames import RTVIClientMessageFrame

# Frames logged once each, the first time any processor pushes them.
WATCHED = {
    "VADUserStartedSpeakingFrame", "VADUserStoppedSpeakingFrame",
    "UserStartedSpeakingFrame", "UserStoppedSpeakingFrame",
    "TranscriptionFrame", "EagerTranscriptionFrame", "EagerEndOfTurnCancelFrame",
    "LLMFullResponseStartFrame", "LLMFullResponseEndFrame", "LLMTextFrame",
    "TTSStartedFrame", "TTSStoppedFrame", "TTSTextFrame", "TTSSpeakFrame",
    "BotStartedSpeakingFrame", "BotStoppedSpeakingFrame",
    "InterruptionFrame",
}
SEEN_LIMIT = 50_000


class _Track:
    """Raw audio written at the position its clock time says, silence in between."""

    def __init__(self, path: Path):
        self.path = path
        self.file = open(path, "wb")
        self.rate: int | None = None
        self.pos = 0  # bytes written

    def write(self, audio: bytes, rate: int, end_ms: float) -> None:
        if self.rate is None:
            self.rate = rate
        if rate != self.rate:
            return  # a track keeps one sample rate; nothing in this bot changes it mid-session
        start = int((end_ms / 1000.0) * rate) * 2 - len(audio)
        start -= start % 2
        if start > self.pos:
            self.file.write(b"\x00" * (start - self.pos))
            self.pos = start
        self.file.write(audio)
        self.pos += len(audio)

    def close(self) -> None:
        self.file.close()
        if self.rate:
            with wave.open(str(self.path.with_suffix(".wav")), "wb") as w:
                w.setnchannels(1); w.setsampwidth(2); w.setframerate(self.rate)
                w.writeframes(self.path.read_bytes())
        self.path.unlink()


class CensusRecorder:
    def __init__(self, root: Path | str, meta: dict | None = None):
        self._t0 = time.perf_counter()
        wall = time.time()
        self.folder = Path(root) / time.strftime("%Y%m%d-%H%M%S", time.gmtime(wall))
        self.folder.mkdir(parents=True, exist_ok=False)
        self._meta = {
            "format": "census-1",
            "started_unix_s": wall,
            "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(wall)),
            **(meta or {}),
        }
        self._events = open(self.folder / "events.jsonl", "w")
        self._client = open(self.folder / "client.jsonl", "w")
        self._agent = _Track(self.folder / "agent.pcm")
        self._user = _Track(self.folder / "user.pcm")
        self._closed = False
        self._write_meta(closed=False)

    def now_ms(self) -> float:
        return (time.perf_counter() - self._t0) * 1000.0

    def _write_meta(self, **extra) -> None:
        (self.folder / "session.json").write_text(json.dumps({**self._meta, **extra}, indent=2))

    def event(self, ev: str, **fields) -> None:
        if not self._closed:
            self._events.write(json.dumps({"t_ms": round(self.now_ms(), 2), "ev": ev, **fields}, separators=(",", ":")) + "\n")

    def agent_audio(self, audio: bytes, rate: int) -> None:
        if not self._closed:
            self._agent.write(audio, rate, self.now_ms())

    def user_audio(self, audio: bytes, rate: int) -> None:
        if not self._closed:
            self._user.write(audio, rate, self.now_ms())

    def client(self, data) -> None:
        if not self._closed:
            self._client.write(json.dumps({"t_ms": round(self.now_ms(), 2), "data": data}, separators=(",", ":")) + "\n")

    def close(self) -> None:
        if self._closed:
            return
        duration = self.now_ms() / 1000.0
        self._closed = True
        self._events.close(); self._client.close()
        self._agent.close(); self._user.close()
        self._write_meta(closed=True, duration_s=round(duration, 2),
                         agent_sample_rate=self._agent.rate, user_sample_rate=self._user.rate)


class CensusObserver(BaseObserver):
    """Writes the frames that mark a reply's progress, and every piece of audio at the transport.

    ``transport_input`` and ``transport_output`` are the pipeline's ``transport.input()`` and
    ``transport.output()``.  Audio pushed *to* the output transport has just been queued there
    ("audio_arrived"); audio pushed on *by* it has just been sent ("audio_sent").
    """

    def __init__(self, transport_input, transport_output, recorder: CensusRecorder, **kwargs):
        super().__init__(**kwargs)
        self._in = transport_input
        self._out = transport_output
        self._rec = recorder
        self._seen: set[int] = set()

    async def on_push_frame(self, data: FramePushed):
        frame = data.frame
        down = data.direction == FrameDirection.DOWNSTREAM
        if isinstance(frame, OutputAudioRawFrame):
            if not down:
                return
            ms = round(1000.0 * len(frame.audio) / (2 * frame.sample_rate * frame.num_channels), 1)
            if data.destination is self._out:
                self._rec.event("audio_arrived", ms=ms, cls=type(frame).__name__, ctx=getattr(frame, "context_id", None))
            elif data.source is self._out:
                self._rec.event("audio_sent", ms=ms, cls=type(frame).__name__)
                self._rec.agent_audio(frame.audio, frame.sample_rate)
            return
        if isinstance(frame, InputAudioRawFrame):
            if data.source is self._in:
                self._rec.user_audio(frame.audio, frame.sample_rate)
            return
        if isinstance(frame, RTVIClientMessageFrame):
            if self._first(frame) and frame.type == "client_stats":
                self._rec.client(frame.data)
            return
        name = type(frame).__name__
        if name not in WATCHED or not self._first(frame):
            return
        fields = {"src": str(data.source), "dir": "down" if down else "up", "clock_ns": data.timestamp}
        if getattr(frame, "pts", None):
            fields["pts_ns"] = frame.pts
        text = getattr(frame, "text", None)
        if isinstance(text, str):
            fields["text"] = text
        if getattr(frame, "context_id", None):
            fields["ctx"] = frame.context_id
        self._rec.event(name, **fields)

    def _first(self, frame) -> bool:
        if frame.id in self._seen:
            return False
        if len(self._seen) > SEEN_LIMIT:
            self._seen.clear()
        self._seen.add(frame.id)
        return True
