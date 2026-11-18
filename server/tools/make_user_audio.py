"""Make a stand-in for the user's microphone: spoken questions with pauses between them.

Run (from server, on macOS):  python3 tools/make_user_audio.py ../web/public/test-audio/user_questions.wav

Left to itself, with silence on its input, the speech model greets and then says
almost nothing, so a recording of it holds very little gesture.  This writes a
WAV file (16-bit, 24 kHz, one channel) of questions spoken by the built-in macOS
`say` voice, each followed by a pause for the model to answer in.

Only the standard library and the macOS `say` command are used.
"""

from __future__ import annotations

import argparse
import subprocess
import tempfile
import wave
from pathlib import Path

SAMPLE_RATE = 24000
QUESTIONS = [
    "Hi there! How are you doing today?",
    "Can you tell me about your favorite place to travel, and why you like it?",
    "Wow. How big was it? Can you describe it for me?",
    "What do you think is the best way to learn to cook?",
    "Can you explain how to get from the airport to the city center?",
    "That's great. Tell me a short story about a dragon and a tiny mouse.",
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out", help="WAV file to write")
    ap.add_argument("--lead-in", type=float, default=3.0, help="seconds of silence before the first question")
    ap.add_argument("--pause", type=float, default=8.0, help="seconds of silence after each question")
    args = ap.parse_args()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    silence = lambda seconds: b"\x00\x00" * int(seconds * SAMPLE_RATE)
    marks, pcm = [], silence(args.lead_in)
    with tempfile.TemporaryDirectory() as tmp:
        for i, text in enumerate(QUESTIONS):
            part = Path(tmp) / f"q{i}.wav"
            subprocess.run(["say", "-o", str(part), f"--data-format=LEI16@{SAMPLE_RATE}", text], check=True)
            with wave.open(str(part), "rb") as w:
                assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (1, 2, SAMPLE_RATE)
                speech = w.readframes(w.getnframes())
            start = len(pcm) / 2 / SAMPLE_RATE
            pcm += speech
            marks.append((start, len(pcm) / 2 / SAMPLE_RATE, text))
            pcm += silence(args.pause)
    with wave.open(str(out), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm)
    for start, end, text in marks:
        print(f"{start:6.1f} to {end:5.1f} s  {text}")
    print(f"wrote {out}: {len(pcm) / 2 / SAMPLE_RATE:.1f} s")


if __name__ == "__main__":
    main()
