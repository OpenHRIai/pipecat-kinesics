"""Frames of the cascaded turn-cue path.

    llm -> ReplyTextTap -> tts -> CascadeSpeechStage -> TagService -> ActionTagToRTVI -> transport.output()

* :class:`ReplyTextFrame` carries what the tap sees of the language model's reply to the
  stage after the text-to-speech service, which never sees that text itself.
* The cascaded speech stage turns everything it learns into the same ``SpeechStepFrame``
  the full-duplex speech stage emits (``duplex/frames.py``), with a ``SpeechContext``
  whose cascaded fields are filled.
* A tag generator turns those into :class:`ActionTagFrame`, the sibling of
  ``MotionFrame`` for timed events rather than poses.  The relay sends them to clients.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from pipecat.frames.frames import SystemFrame


@dataclass
class ReplyEvent:
    """Something that happened to one reply of the bot, on the bot's clock.

    Parameters:
        reply_id: Identifies the reply: the ``id`` of the ``LLMFullResponseStartFrame``
            that opened it, or 0 for speech that did not come from the language model.
        event: One of ``preparing`` (the language model started a reply), ``first_text``
            (its first piece of text), ``text_complete`` (all of its text),
            ``speech_requested`` (the text-to-speech service started), ``audio`` (a piece
            of synthesized audio was queued for sending), ``words`` (word timestamps
            arrived), ``speech_done`` (the text-to-speech service finished: all audio is
            queued), ``stopped`` (the last audio was sent) or ``interrupted`` (the user
            spoke and the reply's queued audio was dropped).
        t_ms: When it happened, in milliseconds on the bot's clock.
        text: The reply's text so far.
    """

    reply_id: int
    event: str
    t_ms: float
    text: str = ""


@dataclass
class ReplyTextFrame(SystemFrame):
    """From the tap before the text-to-speech service to the stage after it.

    A system frame on purpose.  The text-to-speech service passes system frames on at
    once.  Other frames it does not know it holds behind any audio already queued for
    synthesis (Pipecat 1.12, ``TTSService.process_frame``), which would hold a reply's
    first text back until the previous audio was done and lose the early warning.
    """

    reply: ReplyEvent = None

    def __str__(self):
        return f"{self.name}({self.reply.event}, reply {self.reply.reply_id})"


@dataclass
class ActionTagFrame(SystemFrame):
    """A timed action tag for every body, the event-shaped sibling of ``MotionFrame``.

    Parameters:
        kind: What the tag is about.  ``turn``: the state of the bot's turn (turn cues).
        data: The tag's fields, as they go on the wire (see turn-cue-protocol.md).

    A system frame so that an interruption, which cancels data frames in flight, cannot
    drop the tag that reports it.
    """

    kind: str = "turn"
    data: dict = field(default_factory=dict)

    def __str__(self):
        return f"{self.name}({self.kind}: {self.data.get('status')}, turn {self.data.get('turn')}, rev {self.data.get('rev')})"
