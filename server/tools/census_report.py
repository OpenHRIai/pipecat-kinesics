"""Report on a timing census session recorded by bot_cascade.py (turncue/census.py).

For every spoken reply it lays the server's events beside the audio that was sent, and
answers two questions:

  bid    how long before the first sound did the server know a reply was coming?
  yield  how long before the last sound did the server know the reply was complete?

Usage:  python tools/census_report.py <session folder> [--json out.json]

All times are milliseconds on the server's clock unless a line says "page clock".
"Audible" follows the rule of the turn-taking study: a 10 ms stretch of the agent's audio
within 25 decibels of the loudest stretch of the same reply.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import wave
from pathlib import Path

import numpy as np

AUDIBLE_DB = 25.0
PAUSE_MS = 150.0     # a quiet stretch inside a reply at least this long counts as a pause
FRAME_MS = 10.0


def load(folder: Path):
    events = [json.loads(line) for line in open(folder / "events.jsonl")]
    client = [json.loads(line) for line in open(folder / "client.jsonl")] if (folder / "client.jsonl").exists() else []
    with wave.open(str(folder / "agent.wav")) as w:
        rate = w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64)
    return events, client, pcm, rate


def envelope_db(pcm: np.ndarray, rate: int) -> np.ndarray:
    n = int(rate * FRAME_MS / 1000)
    frames = pcm[: len(pcm) // n * n].reshape(-1, n)
    rms = np.sqrt((frames ** 2).mean(axis=1))
    return 20 * np.log10(np.maximum(rms, 1.0) / 32768.0)


def first(events, name, after, before=float("inf")):
    return next((e for e in events if e["ev"] == name and after <= e["t_ms"] < before), None)


def last(events, name, after, before):
    found = [e for e in events if e["ev"] == name and after <= e["t_ms"] < before]
    return found[-1] if found else None


def when_reached(steps, target):
    """steps: [(time, amount)] in time order.  The time at which the running total reaches target."""
    total = 0.0
    for t, amount in steps:
        total += amount
        if total >= target - 1e-6:
            return t
    return None


def replies(events, env, rate):
    """One record per spoken reply (a reply that reached the text-to-speech service)."""
    # Frames travel both ways through the pipeline; keep one copy of each.
    events = [e for e in events if e.get("dir", "down") == "down"]
    starts = [e for e in events if e["ev"] == "TTSStartedFrame"]
    end_of_session = events[-1]["t_ms"] + 1
    out = []
    for i, tts_start in enumerate(starts):
        t_tts = tts_start["t_ms"]
        t_next = starts[i + 1]["t_ms"] if i + 1 < len(starts) else end_of_session
        llm_start = last(events, "LLMFullResponseStartFrame", 0, t_tts)
        t_llm = llm_start["t_ms"]
        user_stop = last(events, "UserStoppedSpeakingFrame", 0, t_llm + 1)
        token = first(events, "LLMTextFrame", t_llm)
        llm_end = first(events, "LLMFullResponseEndFrame", t_llm)
        tts_stop = first(events, "TTSStoppedFrame", t_tts)
        arrived = [(e["t_ms"], e["ms"]) for e in events if e["ev"] == "audio_arrived" and t_tts <= e["t_ms"] < t_next]
        if not arrived:
            continue
        t_first_arrived = arrived[0][0]
        # An interruption after the reply began drops its queued audio.
        cut = first(events, "InterruptionFrame", t_first_arrived, t_next)
        t_cut = cut["t_ms"] if cut else None
        bot_stop = first(events, "BotStoppedSpeakingFrame", t_first_arrived)
        sent_until = min(t_next, (bot_stop["t_ms"] + 1) if bot_stop else t_next)
        sent = [(e["t_ms"], e["ms"]) for e in events if e["ev"] == "audio_sent" and t_first_arrived <= e["t_ms"] < sent_until]
        if not sent:
            continue
        total_ms = sum(ms for _, ms in arrived)
        t_first_sent, t_last_sent = sent[0][0], sent[-1][0]
        interrupted = t_cut is not None and t_cut <= t_last_sent + 400
        text = "".join(e.get("text", "") for e in events if e["ev"] == "LLMTextFrame" and t_llm <= e["t_ms"] < (llm_end["t_ms"] + 1 if llm_end else t_next))

        # Audible stretches, read from the audio that was actually sent (the wav is on the send clock).
        a = max(0, int((t_first_sent - sent[0][1]) / FRAME_MS))
        b = min(len(env), int(t_last_sent / FRAME_MS) + 1)
        seg = env[a:b]
        loud = seg >= seg.max() - AUDIBLE_DB if len(seg) else np.zeros(0, bool)
        idx = np.flatnonzero(loud)
        rec = {
            "text": text.strip(), "words": len(text.split()), "interrupted": interrupted,
            "t_user_stop": user_stop["t_ms"] if user_stop else None,
            "t_llm_start": t_llm, "t_first_token": token["t_ms"] if token else None,
            "t_tts_started": t_tts, "t_first_arrived": t_first_arrived, "t_first_sent": t_first_sent - sent[0][1],
            "t_llm_end": llm_end["t_ms"] if llm_end else None,
            "t_tts_stopped": tts_stop["t_ms"] if tts_stop and tts_stop["t_ms"] < t_next else None,
            "t_last_arrived": arrived[-1][0], "t_last_sent": t_last_sent,
            "t_bot_stopped": bot_stop["t_ms"] if bot_stop else None,
            "audio_ms": total_ms,
        }
        if len(idx):
            rec["t_audible_on"] = (a + idx[0]) * FRAME_MS
            rec["t_audible_off"] = (a + idx[-1] + 1) * FRAME_MS
            # Pauses: quiet runs between the first and the last audible stretch.
            pauses, run_start = [], None
            for k in range(idx[0], idx[-1] + 1):
                if not loud[k] and run_start is None:
                    run_start = k
                elif loud[k] and run_start is not None:
                    if (k - run_start) * FRAME_MS >= PAUSE_MS:
                        pauses.append(((a + run_start) * FRAME_MS, (k - run_start) * FRAME_MS))
                    run_start = None
            rec["pauses"] = pauses
        if not interrupted and "t_audible_off" in rec:
            # When did the audio for a given send time reach the server's queue?
            def arrival_of(send_t):
                offset = sum(ms for t, ms in sent if t <= send_t)       # audio sent up to that time
                return when_reached(arrived, min(offset, total_ms))
            known = [rec["t_last_arrived"]]
            if rec["t_llm_end"]: known.append(rec["t_llm_end"])
            rec["t_end_known_audio"] = max(known)                         # last audio queued and the text complete
            rec["t_end_known_tts"] = max(known + ([rec["t_tts_stopped"]] if rec["t_tts_stopped"] else []))
            rec["pause_leads"] = [round(p - (arrival_of(p) or p), 1) for p, _ in rec.get("pauses", [])]
        out.append(rec)
    return out


def fates(events):
    """What became of each reply the language model started: silent ones are abandoned bids."""
    down = [e for e in events if e.get("dir", "down") == "down"]
    starts = [e["t_ms"] for e in down if e["ev"] == "LLMFullResponseStartFrame"]
    counts = {"started": len(starts), "no_text": 0, "text_no_sound": 0, "spoken": 0}
    for i, t in enumerate(starts):
        t2 = starts[i + 1] if i + 1 < len(starts) else float("inf")
        has = lambda name: any(e["ev"] == name and t <= e["t_ms"] < t2 for e in events)
        if has("audio_arrived"):
            counts["spoken"] += 1
        elif has("LLMTextFrame"):
            counts["text_no_sound"] += 1
        else:
            counts["no_text"] += 1
    return counts


def client_side(client):
    """Arrival of the standard turn messages and audible audio on the page's clock, per spoken reply."""
    marks = [m for r in client for m in (r["data"].get("census") or [])]
    marks.sort(key=lambda m: m[1])
    delays = [r["data"]["delay"] for r in client if r["data"].get("delay")]
    audio_delay = [(d.get("jitterMs") or 0) + (d.get("playoutMs") or 0) for d in delays if d.get("jitterMs") is not None]
    starts = [t for n, t in marks if n == "bot-tts-started"]
    out = []
    for i, t_tts in enumerate(starts):
        t_next = starts[i + 1] if i + 1 < len(starts) else float("inf")
        def before(name):
            c = [t for n, t in marks if n == name and t <= t_tts]
            return c[-1] if c else None
        def after(name, lastone=False):
            c = [t for n, t in marks if n == name and t_tts <= t < t_next]
            return (c[-1] if lastone else c[0]) if c else None
        out.append({
            "llm_started": before("bot-llm-started"), "tts_started": t_tts,
            "started_speaking": after("bot-started-speaking"), "tts_stopped": after("bot-tts-stopped"),
            "stopped_speaking": after("bot-stopped-speaking"),
            "heard_on": after("heard-on"), "heard_off": after("heard-off", lastone=True),
        })
    return out, audio_delay


def cue_check(events, recs, client):
    """Turn cues against the sound they describe.  Server clock for both, so the comparison is direct.

    Returns one row per spoken reply that has cues: errors of the announced times against the
    measured sound, and how long before the sound each piece of knowledge was sent.  The page's
    columns are on its own clock: how long before the sound was heard each message arrived.
    """
    cues = [e["msg"] for e in events if e["ev"] == "turn_cue" and not e.get("heartbeat")]
    if not cues:
        return []
    by_turn: dict[int, list] = {}
    for m in cues:
        by_turn.setdefault(m["turn"], []).append(m)
    page_cues = [c for r in client for c in (r["data"].get("cues") or [])]
    marks = sorted((m for r in client for m in (r["data"].get("census") or [])), key=lambda m: m[1])
    heard_on = [t for n, t in marks if n == "heard-on"]
    heard_off = [t for n, t in marks if n == "heard-off"]
    rows = []
    for rec in recs:
        on, off = rec.get("t_audible_on"), rec.get("t_audible_off")
        if on is None:
            continue
        best = None
        for turn, ms in by_turn.items():
            exact = [m for m in ms if m.get("onset_exact")]
            if exact and abs(exact[0]["onset_ms"] - on) < 300 and (best is None or abs(exact[0]["onset_ms"] - on) < best[0]):
                best = (abs(exact[0]["onset_ms"] - on), turn)
        if best is None:
            continue
        ms = by_turn[best[1]]
        first = lambda pred: next((m for m in ms if pred(m)), None)
        m_text, m_exact = first(lambda m: m.get("text_started")), first(lambda m: m.get("onset_exact"))
        m_end = first(lambda m: m.get("end_ms") is not None and m["status"] == "speaking")
        last = ms[-1]
        row = {
            "turn": best[1], "interrupted": rec["interrupted"], "statuses": [m["status"] for m in ms],
            "onset_error": round(m_exact["onset_ms"] - on, 1),
            "bid_lead": None if m_text is None else round(on - m_text["now_ms"], 1),
            "bid_estimate_error": None if m_text is None else round(m_text["onset_ms"] - on, 1),
            "exact_lead": round(on - m_exact["now_ms"], 1),
        }
        if not rec["interrupted"] and off is not None and m_end is not None:
            row["end_error"] = round(m_end["end_ms"] - off, 1)
            row["yield_lead"] = round(off - m_end["now_ms"], 1)
            segs = (m_end or last)["segments"]
            gaps = [(a["end_ms"], b["start_ms"]) for a, b in zip(segs, segs[1:])]
            row["pauses_announced"] = len(gaps)
            row["pauses_measured"] = len(rec.get("pauses", []))
            errs = []
            for start, dur in rec.get("pauses", []):
                near = min(gaps, key=lambda g: abs(g[0] - start), default=None)
                if near and abs(near[0] - start) < 200:
                    errs.append((round(near[0] - start, 1), round(near[1] - (start + dur), 1)))
            row["pause_errors"] = errs
        # The page: arrival of the same knowledge against the sound as heard there.
        pc = [c for c in page_cues if c[1] == best[1]]
        p_text = next((c for c in pc if c[8]), None)
        p_end = next((c for c in pc if c[6] is not None and c[3] == "speaking"), None)
        if p_text:
            h = next((t for t in heard_on if t > p_text[0]), None)
            row["page_bid_lead"] = None if h is None or h - p_text[0] > 5000 else round(h - p_text[0], 1)
        if p_end and not rec["interrupted"]:
            # The page marks "heard off" after 200 ms of quiet, so pauses inside a reply mark it too.
            # The reply's end is the first one followed by at least 0.8 s of quiet.
            def ends_turn(t):
                nxt = next((x for x in heard_on if x > t), None)
                return nxt is None or nxt - t >= 800
            h = next((t for t in heard_off if t > p_end[0] and ends_turn(t)), None)
            row["page_yield_lead"] = None if h is None or h - p_end[0] > 30000 else round(h - p_end[0], 1)
        rows.append(row)
    return rows


def realizer_check(client):
    """The robot's movements from turn cues (src/robot/turn-realizer.js) against the sound heard on the page.

    Everything here is on the page's clock.  The page marks "heard on" and "heard off" from the decoded audio,
    before the loudspeaker, so the session's median playout delay is added to get the sound as heard.

    Each movement has a key moment meant to meet a sound: the bid is in place at the first sound, the torso
    turns away from it, the torso is back by the last sound, the arms start down at it.  Timing error = key
    moment minus measured sound, negative = early.  Two parts make it up, reported separately per turn:
    the clock error (the exact announced time, mapped to this page, minus the measured sound) and the
    estimate error (a movement that started on an estimate of the first sound, before it was exact).
    """
    reports = [r["data"] for r in client]
    moves = [m for d in reports for m in ((d.get("turn_cue_robot") or {}).get("moves") or [])]
    if not moves:
        return [], [], None
    playout = [d["delay"].get("playoutMs") for d in reports if d.get("delay") and d["delay"].get("playoutMs") is not None]
    po = statistics.median(playout) if playout else 0.0
    page_cues = sorted((c for d in reports for c in (d.get("cues") or [])), key=lambda c: c[0])
    marks = sorted((m for d in reports for m in (d.get("census") or [])), key=lambda m: m[1])
    heard_on = [t for n, t in marks if n == "heard-on"]
    heard_off = [t for n, t in marks if n == "heard-off"]
    # The audio delay the page used (jitter buffer plus playout), by report time.
    # What the page added to "arrival of the message plus its lead", by report time, and the sound lag within it.
    # Sessions before 2026-11-18 added Chrome's jitter buffer and playout figures and a learned trim instead.
    def page_terms(d):
        t = d["turn_cue_robot"]
        if "addedMs" in t:
            return d["perf_ms"], t["addedMs"], t.get("lagMs"), bool(t.get("lagLearned"))
        return d["perf_ms"], t["audioDelayMs"] + (t.get("trimMs") or 0.0), None, None
    used = [page_terms(d) for d in reports if d.get("turn_cue_robot")]

    def ends_turn(t):
        nxt = next((x for x in heard_on if x > t), None)
        return nxt is None or nxt - t >= 800

    def sound_of(turn, aim):
        """The measured sound (heard on the page, plus playout) that a turn's movement aims at."""
        first = next((c for c in page_cues if c[1] == turn), None)
        if first is None:
            return None
        if aim == "onset":
            t = next((t for t in heard_on if t > first[0]), None)
        else:
            known = next((c[0] for c in page_cues if c[1] == turn and c[6] is not None), first[0])
            t = next((t for t in heard_off if t > known and ends_turn(t)), None)
        return None if t is None else t + po

    # A turn's final state: a cancelled turn has no sound to meet, an interrupted one no last sound.
    final = {}
    for c in page_cues:
        final[c[1]] = c[3]
    # Every turn's first and last sound as heard, for the audio fallback's movements, which know no turns.
    turn_sounds = {t: (sound_of(t, "onset"), sound_of(t, "end") if final.get(t) == "ended" else None)
                   for t in sorted({c[1] for c in page_cues if c[1]})}
    rows = []
    for m in moves:
        row = {k: m.get(k) for k in ("kind", "turn", "source", "aim", "key", "durMs", "bodyLagMs", "onsetExact", "shiftMs")}
        if m.get("source") == "audio":
            # Arms up: judged like a bid (in place at the first sound).  Arms down: like lowering (start at the last sound).
            # One that matches no turn's first sound, or no last sound of a turn that ended, came after an
            # interruption or inside a reply (a long pause taken for the end, or the sound after it).
            up = m["kind"] == "audio-up"
            best = None
            for t, (on, off) in turn_sounds.items():
                sound = on if up else off
                if sound is not None and -300 <= m["startMs"] - sound <= (300 if up else 1500):
                    if best is None or abs(m["startMs"] - sound) < abs(m["startMs"] - best[1]):
                        best = (t, sound)
            row["late_start"] = 0.0
            if best is None:
                row["inside_reply"] = True
            else:
                row["turn"], row["aim"], row["key"] = best[0], "onset" if up else "end", "end" if up else "start"
                row["error"] = round(m["startMs"] + (m["durMs"] if up else 0) - best[1], 1)
                row["lead"] = round(best[1] - m["startMs"], 1)
            rows.append(row)
            continue
        row["turn_status"] = final.get(m.get("turn"))
        if row["turn_status"] == "cancelled" or (row["turn_status"] == "interrupted" and m.get("aim") == "end"):
            row["late_start"] = round(m["startMs"] - m["wantedMs"], 1) if m.get("wantedMs") is not None else None
            rows.append(row)
            continue
        row["late_start"] = round(m["startMs"] - m["wantedMs"], 1) if m.get("wantedMs") is not None else None
        if m.get("aim") in ("onset", "end") and m.get("turn") is not None:
            sound = sound_of(m["turn"], m["aim"])
            if sound is not None and abs(sound - m["startMs"]) < 5000:
                # Sessions recorded before 2026-11-17 11:30 lack "key" and "soundMs".
                row["key"] = m.get("key") or {"bid": "end", "back": "end"}.get(m["kind"], "start")
                key = m["startMs"] + (m["durMs"] if row["key"] == "end" else 0)
                row["error"] = round(key - sound, 1)
                row["lead"] = round(sound - m["startMs"], 1)            # started this long before the sound
                if m.get("soundMs") is not None:
                    row["expected_error"] = round(m["soundMs"] - sound, 1)  # what it believed, minus the sound
        rows.append(row)

    # Clock error per turn: the exact times announced, mapped with the page's own offset and audio delay.
    clock = []
    for turn in sorted({c[1] for c in page_cues if c[1]}):
        cs = [c for c in page_cues if c[1] == turn]
        offset = min(c[0] - c[7] for c in page_cues if abs(c[0] - cs[0][0]) < 10000)
        # What the page was adding when the turn began.
        _, added, lag, learned = min(used, key=lambda u: abs(u[0] - cs[0][0])) if used else (0, 0.0, None, None)
        row = {"turn": turn, "status": cs[-1][3], "added": added, "lag": lag, "lag_learned": learned}
        exact = next((c for c in cs if c[5]), None)
        on = sound_of(turn, "onset")
        if exact and on is not None and abs(exact[4] + offset + added - on) < 2000:
            row["onset_clock_error"] = round(exact[4] + offset + added - on, 1)
            # The sound lag this turn shows: the decoded sound minus where its message put it.
            row["onset_lag"] = round(on - po - (exact[4] + offset), 1)
        endc = None if cs[-1][3] != "ended" else next((c for c in cs if c[6] is not None and c[3] in ("speaking", "ended")), None)
        off = sound_of(turn, "end")
        if endc and off is not None and abs(endc[6] + offset + added - off) < 2000:
            row["end_clock_error"] = round(endc[6] + offset + added - off, 1)
            row["end_lag"] = round(off - po - (endc[6] + offset), 1)
        clock.append(row)
    return rows, clock, po


def diff(a, b):
    return None if a is None or b is None else round(a - b, 1)


def summarize(values):
    v = sorted(x for x in values if x is not None)
    if not v:
        return "no data"
    return f"median {statistics.median(v):.0f} ms, range {v[0]:.0f} to {v[-1]:.0f} ms, {len(v)} replies"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("folder", type=Path)
    ap.add_argument("--json", type=Path)
    args = ap.parse_args(argv)
    events, client, pcm, rate = load(args.folder)
    env = envelope_db(pcm, rate)
    recs = replies(events, env, rate)
    page, audio_delay = client_side(client)
    meta = json.loads((args.folder / "session.json").read_text())

    print(f"Session {args.folder.name}: {meta.get('duration_s')} s, {meta.get('stt')} / {meta.get('llm')} / {meta.get('tts')}")
    llm_starts = sum(1 for e in events if e["ev"] == "LLMFullResponseStartFrame" and e.get("dir") == "down")
    f = fates(events)
    print(f"Replies started by the language model: {llm_starts}.  Replies that reached speech: {len(recs)}, "
          f"of which interrupted: {sum(r['interrupted'] for r in recs)}.")
    print(f"Replies dropped before any sound: {f['no_text']} before the first word of text, "
          f"{f['text_no_sound']} after it.")
    print()
    print("| # | words | audio s | user stop to first sound | reply start to first sound | first token to first sound | "
          "speech request to first sound | end known before last sound | pauses | pause known ahead |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    rows = []
    for i, r in enumerate(recs):
        on, off = r.get("t_audible_on"), r.get("t_audible_off")
        row = {
            "user_stop_to_on": diff(on, r["t_user_stop"]), "llm_start_to_on": diff(on, r["t_llm_start"]),
            "token_to_on": diff(on, r["t_first_token"]), "tts_started_to_on": diff(on, r["t_tts_started"]),
            "arrived_to_on": diff(on, r["t_first_arrived"]),
            "yield_lead_audio": diff(off, r.get("t_end_known_audio")), "yield_lead_tts": diff(off, r.get("t_end_known_tts")),
            "stopped_msg_after_off": diff(r["t_bot_stopped"], off),
        }
        rows.append(row)
        pauses = r.get("pauses", [])
        leads = r.get("pause_leads", [])
        f = lambda x: "–" if x is None else f"{x:.0f} ms"
        print(f"| {i + 1}{' (interrupted)' if r['interrupted'] else ''} | {r['words']} | {(off - on) / 1000 if on else 0:.1f} | "
              f"{f(row['user_stop_to_on'])} | {f(row['llm_start_to_on'])} | {f(row['token_to_on'])} | {f(row['tts_started_to_on'])} | "
              f"{f(row['yield_lead_tts'])} | {len(pauses)}: {', '.join(f'{d:.0f}' for _, d in pauses) or '–'} ms | "
              f"{', '.join(f'{x:.0f}' for x in leads) or '–'} ms |")
    print()
    print("Server clock, audible sound as it leaves the server:")
    for key, label in [
        ("user_stop_to_on", "user's turn judged over, to the first sound"),
        ("llm_start_to_on", "reply starts being prepared, to the first sound (the longest possible bid lead)"),
        ("token_to_on", "first word of the reply's text, to the first sound"),
        ("tts_started_to_on", "speech requested from the text-to-speech service, to the first sound"),
        ("arrived_to_on", "first audio queued at the transport, to the first sound"),
        ("yield_lead_audio", "reply complete (text done and last audio queued), to the last sound"),
        ("yield_lead_tts", "same, also waiting for the text-to-speech service to say it has finished"),
        ("stopped_msg_after_off", "last sound, to Pipecat's own 'bot stopped speaking'"),
    ]:
        print(f"  {label}: {summarize(r[key] for r in rows)}")
    print()
    if page:
        print("Page clock, audible sound after the browser's jitter buffer:")
        for a, b, label in [
            ("heard_on", "llm_started", "'bot-llm-started' arrives, to the first sound heard"),
            ("heard_on", "tts_started", "'bot-tts-started' arrives, to the first sound heard"),
            ("heard_on", "started_speaking", "'bot-started-speaking' arrives, to the first sound heard"),
            ("heard_off", "tts_stopped", "'bot-tts-stopped' arrives, to the last sound heard"),
            ("stopped_speaking", "heard_off", "last sound heard, to 'bot-stopped-speaking' arriving"),
        ]:
            print(f"  {label}: {summarize(diff(p[a], p[b]) for p in page)}")
        if audio_delay:
            print(f"  browser's jitter buffer plus playout delay: median {statistics.median(audio_delay):.0f} ms over {len(audio_delay)} reports")
    acoustic = [x for r in client for x in ((r["data"].get("acoustic") or {}).get("results") or [])]
    if acoustic:
        good = sorted(x["lagMs"] for x in acoustic if x["corr"] >= 0.5)
        playout = [r["data"]["delay"].get("playoutMs") for r in client if r["data"].get("delay") and r["data"]["delay"].get("playoutMs") is not None]
        print()
        print("Acoustic check (?acoustic=1): the room microphone against the decoded bot audio:")
        if good:
            q = lambda f: good[min(len(good) - 1, int(f * len(good)))]
            print(f"  lag: median {statistics.median(good):.0f} ms, middle half {q(0.25):.0f} to {q(0.75):.0f} ms, "
                  f"{len(good)} windows with a match of 0.5 or better out of {len(acoustic)}")
        else:
            print(f"  no window with a match of 0.5 or better out of {len(acoustic)}: speakers too quiet, or headphones in use?")
        if playout:
            print(f"  Chrome's own playout delay figure in the same session: median {statistics.median(playout):.0f} ms")
    checks = cue_check(events, recs, client)
    if checks:
        print()
        print("Turn cues against the sound (server clock; negative error = announced earlier than measured):")
        f = lambda x: "–" if x is None else f"{x:.0f}"
        print("| turn | outcome | onset error ms | end error ms | pauses announced / measured | pause start, end errors ms | "
              "bid lead ms (server / page) | exact onset lead ms | yield lead ms (server / page) |")
        print("|---|---|---|---|---|---|---|---|---|")
        for c in checks:
            print(f"| {c['turn']} | {c['statuses'][-1]} | {f(c['onset_error'])} | {f(c.get('end_error'))} | "
                  f"{c.get('pauses_announced', '–')} / {c.get('pauses_measured', '–')} | "
                  f"{'; '.join(f'{a:.0f}, {b:.0f}' for a, b in c.get('pause_errors', [])) or '–'} | "
                  f"{f(c['bid_lead'])} / {f(c.get('page_bid_lead'))} | {f(c['exact_lead'])} | "
                  f"{f(c.get('yield_lead'))} / {f(c.get('page_yield_lead'))} |")
        for key, label in [("onset_error", "onset announced minus measured"), ("end_error", "end announced minus measured"),
                           ("bid_estimate_error", "first estimate of the onset minus measured")]:
            v = [c[key] for c in checks if c.get(key) is not None]
            if v:
                print(f"  {label}: median {statistics.median(v):.0f} ms, range {min(v):.0f} to {max(v):.0f} ms, {len(v)} replies")
        pe = [e for c in checks for pair in c.get("pause_errors", []) for e in pair]
        if pe:
            print(f"  pause boundaries announced minus measured: median {statistics.median(pe):.0f} ms, "
                  f"range {min(pe):.0f} to {max(pe):.0f} ms, {len(pe)} boundaries")
    moves, clock_rows, po = realizer_check(client)
    if moves:
        print()
        fps = [r["data"]["fps"] for r in client if r["data"].get("fps") is not None]
        if fps:
            low = sum(f < 30 for f in fps)
            print(f"The page drew a median of {statistics.median(fps):.0f} frames per second; {low} of {len(fps)} reports below 30."
                  + ("  THE PAGE WAS THROTTLED (hidden or busy): it runs the robot and detects the sound once per frame,"
                     " so the timing below is not meaningful." if statistics.median(fps) < 30 else ""))
        print(f"Robot movements from turn cues, page clock (sound heard = decoded + {po:.0f} ms median playout delay; "
              "negative = early):")
        f = lambda x: "–" if x is None else f"{x:.0f}"
        print("| turn | movement | meets the sound at its | duration ms | started late by ms | started before the sound ms | "
              "timing error ms | of which the expected sound was off by ms | body lag ms |")
        print("|---|---|---|---|---|---|---|---|---|")
        for m in moves:
            meets = "–" if m["aim"] == "now" else f"{m['key']} / {m['aim']}"
            print(f"| {f(m['turn'])} | {m['kind']} | {meets} | {f(m['durMs'])} | {f(m['late_start'])} | "
                  f"{f(m.get('lead'))} | {f(m.get('error'))} | {f(m.get('expected_error'))} | {f(m['bodyLagMs'])} |")
        # A bid re-timed to the exact first sound ('bid-retime') ends when its re-timing says: judge the bid by that.
        final_bid = {}
        for m in moves:
            if m["kind"] in ("bid", "bid-retime") and m.get("error") is not None:
                final_bid[m["turn"]] = m
        retimed = [m for m in moves if m["kind"] == "bid-retime"]
        for kind, sel in (("bid, as finally timed", list(final_bid.values())), ("bid, as first started", [m for m in moves if m["kind"] == "bid"]),
                          ("away", None), ("back", None), ("lower", None)):
            e = [m["error"] for m in (sel if sel is not None else [m for m in moves if m["kind"] == kind]) if m.get("error") is not None]
            if e and (kind != "bid, as first started" or retimed):
                print(f"  {kind}: timing error median {statistics.median(e):.0f} ms, range {min(e):.0f} to {max(e):.0f} ms, "
                      f"{sum(abs(x) <= 80 for x in e)} of {len(e)} within 80 ms")
        if retimed:
            shifts = ", ".join(f"{m['shiftMs']:+.0f}" for m in retimed if m.get("shiftMs") is not None)
            print(f"  bids re-timed to the exact first sound: {len(retimed)}, their ends moved by {shifts} ms")
        timed = [m for m in moves if m["source"] == "cues" and m["aim"] != "now"]
        audio = [m for m in moves if m["source"] == "audio"]
        if audio:
            print("  The audio fallback (?cues=audio), its movements against the turns' sound:")
            for kind, label in (("audio-up", "arms up, in place, minus the first sound"), ("audio-down", "arms down, start, minus the last sound")):
                e = [m["error"] for m in audio if m["kind"] == kind and m.get("error") is not None]
                inside = sum(1 for m in audio if m["kind"] == kind and m.get("inside_reply"))
                if e:
                    print(f"    {label}: median {statistics.median(e):.0f} ms, range {min(e):.0f} to {max(e):.0f} ms, "
                          f"{sum(abs(x) <= 80 for x in e)} of {len(e)} within 80 ms; {inside} more after an interruption or inside a reply")
        if timed:
            late = [m for m in timed if (m["late_start"] or 0) > 20]
            print(f"  movements that started more than 20 ms after they should have: {len(late)} of {len(timed)}")
        lag = [m["bodyLagMs"] for m in moves if m["bodyLagMs"] is not None]
        if lag:
            print(f"  body lag, limb in place after its command: median {statistics.median(lag):.0f} ms, max {max(lag):.0f} ms, {len(lag)} movements")
        for key, label in (("onset_clock_error", "first sound"), ("end_clock_error", "last sound")):
            e = [c[key] for c in clock_rows if c.get(key) is not None]
            if e:
                print(f"  clock error, exact {label} as the page placed it, minus heard: median {statistics.median(e):.0f} ms, "
                      f"range {min(e):.0f} to {max(e):.0f} ms, {len(e)} turns")
        for key, label in (("onset_lag", "first sound"), ("end_lag", "last sound")):
            e = [c[key] for c in clock_rows if c.get(key) is not None]
            if e:
                print(f"  sound lag each turn shows at its {label} (decoded sound minus arrival plus lead): "
                      f"median {statistics.median(e):.0f} ms, range {min(e):.0f} to {max(e):.0f} ms")
        if any(c.get("lag") is not None for c in clock_rows):
            print("  sound lag in use at the start of each turn (* = still the starting value): "
                  + ", ".join(f"{c['lag']:.0f}{'' if c['lag_learned'] else '*'}" for c in clock_rows if c.get("lag") is not None) + " ms")
    if args.json:
        args.json.write_text(json.dumps({"session": meta, "fates": fates(events), "cue_checks": checks, "robot_moves": moves, "robot_clock": clock_rows,
                                         "replies": recs, "derived": rows, "page": page}, indent=2))
        print(f"\nwrote {args.json}")


if __name__ == "__main__":
    sys.exit(main())
