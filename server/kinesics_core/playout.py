"""Measure how much of the agent's audio is waiting in Pipecat's output transport.

The model's audio leaves the server through Pipecat's output transport, which
sends it to the network in real time: 80 ms of audio takes 80 ms to go.  Audio
handed to it faster than that waits in its queue, and the queue is never sent
faster than real time.  So after a burst of steps (the microphone audio arrived
in a bunch, or slow steps were caught up) the queue stays.  In the first recorded
session it was estimated at about 200 ms for most of the conversation; on the
local bot it was measured at 70 to 80 ms, from 2 steps that arrived together at
the start.

Pipecat's sending is left exactly as it is.  This module
only measures the queue:

* :class:`AudioPlayout` counts the audio handed to the output transport and the
  audio the transport has sent, so the queue length is known at any moment.
* :class:`PlayoutObserver` is a Pipecat observer that sees each audio piece the
  output transport pushes on after sending it.  It feeds the count, and it tells
  the session recorder when each piece arrived at the transport and when it left.

Why it matters beyond the measurement.  Audio still in the queue has been
generated but not yet heard.  So when the motion model makes the poses for a
step, it has already seen the speech up to the queue length ahead of what the
listener hears.  A gesture generator that knows the queue length can use that
as look-ahead: start a stroke early enough for its peak to land on a stressed
syllable that is still in the queue.  The speech stage reports the queue length
with every step (``audio_queue_ms`` in the step's statistics) for that purpose.
"""

from __future__ import annotations

import time

from pipecat.frames.frames import OutputAudioRawFrame
from pipecat.observers.base_observer import BaseObserver, FramePushed
from pipecat.processors.frame_processor import FrameDirection

BYTES_PER_MS = 48  # 24,000 samples per second, 2 bytes each


class AudioPlayout:
    """How much of the agent's audio is waiting in the output transport, in milliseconds."""

    # Until a client is connected, Pipecat's WebRTC transport discards the audio it is given
    # instead of queueing it.  So counting starts with the first chunk actually sent.  The
    # audio handed over just before that is not counted; when it is sent the count is clipped,
    # so the error does not stay.

    def __init__(self):
        self.handed_bytes = 0
        self.sent_bytes = 0
        self.started = False
        self.last_sent_s: float | None = None

    def handed(self, nbytes: int) -> None:
        if self.started:
            self.handed_bytes += nbytes

    def begin(self) -> None:
        """Count from now on: a client is connected, so the transport keeps what it is handed.

        A bot that speaks only after its client is ready (the cascaded bot) calls this then;
        without it the count starts at the first piece sent, and the audio of the first reply,
        handed over before that, would be missing from it.
        """
        self.started = True
        self.handed_bytes = self.sent_bytes = 0

    def sent(self, nbytes: int) -> None:
        if not self.started:
            self.started = True
            self.handed_bytes = self.sent_bytes = 0
            return
        self.sent_bytes = min(self.sent_bytes + nbytes, self.handed_bytes)
        self.last_sent_s = time.perf_counter()

    def flush(self) -> None:
        """The transport dropped its queue (an interruption): nothing handed over is waiting any more."""
        self.handed_bytes = self.sent_bytes

    @property
    def queued_ms(self) -> float:
        """Audio handed over and not yet reported sent.  Pipecat reports a 40 ms piece as sent when
        its last 10 ms leave, so the piece going out at that moment is partly counted."""
        return (self.handed_bytes - self.sent_bytes) / BYTES_PER_MS


class PlayoutObserver(BaseObserver):
    """Watches the output transport.  Audio pushed on by it has just been sent; audio pushed to it has just arrived.

    ``transport_output`` is the pipeline's output transport, ``transport.output()``.
    """

    def __init__(self, transport_output, playout: AudioPlayout, recorder=None, **kwargs):
        super().__init__(**kwargs)
        self._out = transport_output
        self._playout = playout
        self._recorder = recorder

    async def on_push_frame(self, data: FramePushed):
        if data.direction != FrameDirection.DOWNSTREAM or not isinstance(data.frame, OutputAudioRawFrame):
            return
        if data.source is self._out:
            n = len(data.frame.audio)
            self._playout.sent(n)
            if self._recorder:
                self._recorder.audio_out("sent", n)
        elif data.destination is self._out and self._recorder:
            self._recorder.audio_out("arrived", len(data.frame.audio))
