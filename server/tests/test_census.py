"""The census recorder lays audio on the send clock, and the report reads leads from it."""

import json
import math
import struct
import sys
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

import census_report as report  # noqa: E402
from turncue.census import _Track  # noqa: E402

RATE = 24000


def tone(ms: float, amplitude: float = 8000.0) -> bytes:
    n = int(RATE * ms / 1000)
    return b"".join(struct.pack("<h", int(amplitude * math.sin(2 * math.pi * 220 * i / RATE))) for i in range(n))


def test_track_places_audio_at_its_send_time(tmp_path):
    track = _Track(tmp_path / "agent.pcm")
    track.write(tone(40), RATE, end_ms=1040.0)   # sent from 1000 to 1040 ms
    track.write(tone(40), RATE, end_ms=1080.0)
    track.close()
    with wave.open(str(tmp_path / "agent.wav")) as w:
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    assert len(pcm) == int(RATE * 1.080)
    assert not pcm[: int(RATE * 1.0)].any()       # silence before the first piece
    assert pcm[int(RATE * 1.0):].any()


def test_when_reached():
    steps = [(10.0, 40.0), (20.0, 40.0), (30.0, 40.0)]
    assert report.when_reached(steps, 40.0) == 10.0
    assert report.when_reached(steps, 41.0) == 20.0
    assert report.when_reached(steps, 500.0) is None


def test_reply_leads_from_a_synthetic_session():
    # One reply: 2 seconds of audio (1 s tone, 0.4 s quiet, 0.6 s tone) that reaches the
    # transport's queue all at once at 1000 ms and is sent in real time from then on.
    audio = tone(1000) + bytes(int(RATE * 0.4) * 2) + tone(600)
    piece = int(RATE * 0.04) * 2
    events = [
        {"t_ms": 100.0, "ev": "UserStoppedSpeakingFrame", "dir": "down"},
        {"t_ms": 101.0, "ev": "LLMFullResponseStartFrame", "dir": "down"},
        {"t_ms": 600.0, "ev": "LLMTextFrame", "dir": "down", "text": "Hello there."},
        {"t_ms": 700.0, "ev": "TTSStartedFrame", "dir": "down"},
        {"t_ms": 900.0, "ev": "LLMFullResponseEndFrame", "dir": "down"},
    ]
    events += [{"t_ms": 1000.0 + k * 0.01, "ev": "audio_arrived", "ms": 40.0} for k in range(len(audio) // piece)]
    events.append({"t_ms": 1001.0, "ev": "TTSStoppedFrame", "dir": "down"})
    pcm = np.zeros(int(RATE * 3.2), dtype=np.int16)
    for k in range(len(audio) // piece):
        end_ms = 1000.0 + (k + 1) * 40.0
        events.append({"t_ms": end_ms, "ev": "audio_sent", "ms": 40.0})
        a = int(RATE * (end_ms - 40.0) / 1000)
        pcm[a: a + piece // 2] = np.frombuffer(audio[k * piece: (k + 1) * piece], dtype=np.int16)
    events.append({"t_ms": 3000.0, "ev": "BotStoppedSpeakingFrame", "dir": "down"})
    events.sort(key=lambda e: e["t_ms"])

    recs = report.replies(events, report.envelope_db(pcm.astype(np.float64), RATE), RATE)
    assert len(recs) == 1
    r = recs[0]
    assert not r["interrupted"]
    assert abs(r["t_audible_on"] - 1000.0) <= 10.0
    assert abs(r["t_audible_off"] - 3000.0) <= 10.0
    assert len(r["pauses"]) == 1 and abs(r["pauses"][0][1] - 400.0) <= 20.0
    assert abs(r["pauses"][0][0] - 2000.0) <= 10.0
    # The whole reply was queued by about 1001 ms, so the end was known about 2 s before the last sound,
    # and the pause about 1 s before it began.
    assert abs((r["t_audible_off"] - r["t_end_known_tts"]) - 1999.0) <= 15.0
    assert abs(r["pause_leads"][0] - 1000.0) <= 50.0
    json.dumps(recs)  # the report must stay serialisable
