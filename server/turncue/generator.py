"""TurnCueGenerator: the state of the bot's turn, from a cascaded speech stage's contexts.

It is a tag generator: like a motion generator it reads ``SpeechStep`` objects, one by one,
and declares the context fields it needs (``requires``); unlike one it returns timed tags,
not poses.  Each tag is the whole state of the current turn (turn-cue-protocol.md), so a
client that misses one loses nothing once the next arrives.

When it emits a new state, and what the state says, for one reply:

=====================  ==========  ======================================================
Event                  ``status``  What changes
=====================  ==========  ======================================================
preparing              preparing   a new ``turn``; nothing known about the sound yet
first_text             preparing   ``text_started``; ``onset_ms`` estimated
speech_requested       preparing   ``onset_ms`` estimated more closely
first audible audio    speaking    ``onset_ms`` exact; the first segment opens
a pause in the audio   speaking    the open segment closes; the next opens after it
text_complete          (same)      ``words``
speech_done            (same)      the last segment closes; ``end_ms`` is set
stopped                ended
interrupted            interrupted ``end_ms`` is now (or ``cancelled`` with no sound yet)
=====================  ==========  ======================================================

The estimates of ``onset_ms`` before any audio exists come from measured sessions: with Deepgram, OpenAI gpt-5.5 and Cartesia
sonic-3.6, the first sound came a median 0.51 s after the first text and 0.36 s after speech
was requested.  They are service-specific and only estimates; ``onset_exact`` says which.

"Audible" follows the turn-taking study: 10 ms of audio within 25 decibels of the loudest
10 ms of the reply so far, and above an absolute floor.  A quiet run of at least
``pause_ms`` inside a reply is a pause.
"""

from __future__ import annotations

import numpy as np

FIRST_TEXT_TO_SOUND_MS = 510.0
SPEECH_REQUEST_TO_SOUND_MS = 360.0
AUDIBLE_DB = 25.0          # within this many decibels of the loudest 10 ms so far
FLOOR_DBFS = -50.0         # and never quieter than this (decibels below full scale)
PAUSE_MS = 150.0
FRAME_MS = 10.0
WIRE_VERSION = 1


class TurnCueGenerator:
    """One per session.  ``step(speech)`` returns ``(tags, timings)``; each tag is a dict for the wire."""

    requires = ("reply",)

    def __init__(self, *, pause_ms: float = PAUSE_MS):
        self.pause_ms = pause_ms
        self.reset()

    # ------------------------------------------------------------------ state
    def reset(self) -> None:
        self.turn = 0
        self.rev = 0
        self.status = "idle"
        self.reply_id: int | None = None
        self._clear_turn()

    def _clear_turn(self) -> None:
        self.onset_ms: float | None = None
        self.onset_exact = False
        self.text_started = False
        self.words: int | None = None
        self.segments: list[list[float | None]] = []
        self.end_ms: float | None = None
        self._max_db = -np.inf
        self._in_sound = False
        self._last_loud_end: float | None = None
        self._carry = np.zeros(0, np.float64)   # audio shorter than 10 ms, kept for the next piece
        self._carry_ms: float | None = None

    def state(self) -> dict:
        return {
            "type": "bot-turn-cue", "v": WIRE_VERSION,
            "turn": self.turn, "rev": self.rev, "status": self.status,
            "text_started": self.text_started,
            "onset_ms": _r(self.onset_ms), "onset_exact": self.onset_exact,
            "segments": [{"start_ms": _r(a), "end_ms": _r(b)} for a, b in self.segments],
            "end_ms": _r(self.end_ms),
            "words": self.words,
        }

    def close(self) -> None:
        pass

    # ------------------------------------------------------------------ steps
    def step(self, speech) -> tuple[list[dict], dict]:
        reply = speech.context.reply
        ev = reply.event
        changed = False

        if ev == "preparing":
            self._new_turn(reply.reply_id, "preparing")
            changed = True
        elif self.status in ("idle", "ended", "cancelled", "interrupted") and ev in ("speech_requested", "audio"):
            # Speech that did not come through the language model (a TTSSpeakFrame), or whose
            # "preparing" was lost: open a turn for it anyway.
            self._new_turn(reply.reply_id, "preparing")
            changed = True

        if reply.reply_id != self.reply_id and ev in ("first_text", "text_complete"):
            pass  # text of a reply that is no longer the current one
        elif ev == "first_text" and self.status == "preparing":
            self.text_started = True
            if not self.onset_exact:
                self.onset_ms = reply.t_ms + FIRST_TEXT_TO_SOUND_MS
            changed = True
        elif ev == "text_complete" and self.status in ("preparing", "speaking") and reply.text.strip():
            # (An empty text is a reply the language model abandoned; the interruption that follows reports it.)
            self.words = len(reply.text.split())
            changed = True
        elif ev == "speech_requested" and self.status == "preparing" and not self.onset_exact:
            self.onset_ms = reply.t_ms + SPEECH_REQUEST_TO_SOUND_MS
            changed = True
        elif ev == "audio" and self.status in ("preparing", "speaking"):
            changed |= self._audio(speech.pcm_out, speech.context.audio_send_ms, speech.context.sample_rate)
        elif ev == "speech_done" and self.status in ("preparing", "speaking"):
            changed |= self._finish_audio()
        elif ev == "stopped" and self.status == "speaking":
            self._finish_audio()
            self.status = "ended"
            changed = True
        elif ev == "interrupted" and self.status in ("preparing", "speaking"):
            if self.onset_exact and self.onset_ms is not None and self.onset_ms <= reply.t_ms:
                self.status = "interrupted"
                cut = reply.t_ms
                if self.segments and self.segments[-1][1] is None:
                    self.segments[-1][1] = min(cut, self._last_loud_end or cut)
                # Segments that had not begun to play will not be heard.
                self.segments = [s for s in self.segments if s[0] < cut]
                self.end_ms = min(cut, self.end_ms) if self.end_ms is not None else cut
            else:
                self.status = "cancelled"
            changed = True

        if not changed:
            return [], {}
        self.rev += 1
        return [self.state()], {}

    def _new_turn(self, reply_id: int, status: str) -> None:
        self._clear_turn()
        self.turn += 1
        self.rev = 0
        self.reply_id = reply_id
        self.status = status

    def _audio(self, pcm: np.ndarray, send_ms: float | None, rate: int | None) -> bool:
        if send_ms is None or not rate or pcm is None or len(pcm) == 0:
            return False
        n = int(rate * FRAME_MS / 1000)
        x = pcm.astype(np.float64)
        if len(self._carry):
            x = np.concatenate([self._carry, x])
            send_ms = self._carry_ms
        whole = len(x) // n * n
        self._carry = x[whole:]
        self._carry_ms = send_ms + 1000.0 * whole / rate
        if whole == 0:
            return False
        rms = np.sqrt((x[:whole].reshape(-1, n) ** 2).mean(axis=1))
        db = 20 * np.log10(np.maximum(rms, 1.0) / 32768.0)
        changed = False
        for i, level in enumerate(db):
            t = send_ms + i * FRAME_MS
            self._max_db = max(self._max_db, level)
            audible = level >= FLOOR_DBFS and level >= self._max_db - AUDIBLE_DB
            if audible:
                if not self._in_sound:
                    self.segments.append([t, None])
                    self._in_sound = True
                    if not self.onset_exact:
                        self.onset_ms, self.onset_exact, self.status = t, True, "speaking"
                    changed = True
                self._last_loud_end = t + FRAME_MS
            elif self._in_sound and t + FRAME_MS - self._last_loud_end >= self.pause_ms:
                self.segments[-1][1] = self._last_loud_end
                self._in_sound = False
                changed = True
        return changed

    def _finish_audio(self) -> bool:
        """All of the reply's audio is queued: the end of the last sound is known."""
        if self.end_ms is not None:
            return False
        if self.segments and self.segments[-1][1] is None:
            self.segments[-1][1] = self._last_loud_end
        self._in_sound = False
        if not self.segments:
            return False
        self.end_ms = self.segments[-1][1]
        return True


def _r(x):
    return None if x is None else round(float(x), 1)
