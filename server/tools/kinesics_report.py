"""Kinesics movements against the sound heard on the page, for one recorded session.

    python tools/kinesics_report.py out/sessions/<session> [--json out.json]

The page reports every movement its kinesics realizer started (web/src/kinesics/kinesics-realizer.js), per
body, in its once-a-second report (`kinesics` in client.jsonl), together with when it heard the bot's sound
start and stop (`census` marks, from the decoded audio; the session's median playout delay is added, as in
census_report.py).  Everything here is on the page's clock.

Each kind of movement has a key moment (its start or its end) that the profile places at a fixed offset from
the bot's first or last sound, for example "the eyes are back 100 ms before the last sound".  For each
movement this prints

    timing error  = (key moment - sound as heard) - the profile's offset      negative = early
    clock error   = where the realizer expected the sound - sound as heard

The clock error is the part of the timing error that comes from mapping the bot's announced time to this
page; the rest is the movement itself (a late cue, a first sound that was still an estimate).
Only turns that reached sound are compared at the first sound, and only turns that ended normally at the last.
"""

from __future__ import annotations

import argparse
import json
import statistics
from pathlib import Path

KIN = Path(__file__).resolve().parents[2] / "web/src/kinesics"
PROFILES = json.loads((KIN / "profiles.json").read_text())
MAPPINGS = json.loads((KIN / "mappings.json").read_text())
GATE_MS = 80.0


def targets(setting: str, body: str, mapping: str | None) -> dict:
    """kind -> (key moment, the sound it is timed against, the profile's offset in ms)."""
    p, b = PROFILES["profiles"][setting], PROFILES["body"]
    group = MAPPINGS["g1" if body == "g1" else "vrm"]
    with_eyes = group.get(mapping or group["default"], {}).get("head_returns_with_eyes")
    head_end = p["yield"]["eyes_return_end_ms"] if with_eyes else p["yield"]["head_return_end_ms"]
    mouth = {} if "mouth" not in p else {
        "mouth-ready": ("end", "onset", p["mouth"]["quarter_open_ms"]),
        "mouth-open": ("end", "onset", p["mouth"]["half_open_ms"]),
        "mouth-open-short": ("end", "onset", p["mouth"]["short_half_open_ms"]),
        "mouth-close": ("end", "end", p["mouth"]["close_end_ms"]),
    }
    return {
        **mouth,
        "look-away-eyes": ("start", "onset", p["bid"]["look_away_start_ms"]),
        "look-away-head": ("end", "onset", p["bid"]["look_away_end_ms"]),
        "dip": ("end", "onset", p["bid"]["dip_peak_ms"]),
        "hand-up": ("end", "onset", b["hand"]["rise_end_ms"]),
        "hand-down": ("start", "end", b["hand"]["lower_start_ms"]),
        "eyes-return": ("end", "end", p["yield"]["eyes_return_end_ms"]),
        "head-return": ("end", "end", head_end),
        "settle": ("end", "end", p["yield"]["settle_end_ms"]),
    }


def analyse(client: list) -> dict:
    reports = [r["data"] for r in client]
    playout = [d["delay"]["playoutMs"] for d in reports if d.get("delay") and d["delay"].get("playoutMs") is not None]
    po = statistics.median(playout) if playout else 0.0
    cues = sorted((c for d in reports for c in (d.get("cues") or [])), key=lambda c: c[0])
    marks = sorted((m for d in reports for m in (d.get("census") or [])), key=lambda m: m[1])
    heard_on = [t for n, t in marks if n == "heard-on"]
    heard_off = [t for n, t in marks if n == "heard-off"]
    final = {c[1]: c[3] for c in cues}
    setting = next((d["kinesics"]["setting"] for d in reports if d.get("kinesics")), "video_call")

    def ends_turn(t):
        nxt = next((x for x in heard_on if x > t), None)
        return nxt is None or nxt - t >= 800

    def sound_of(turn, aim):
        first = next((c for c in cues if c[1] == turn), None)
        if first is None or final.get(turn) in (None, "cancelled") or (aim == "end" and final.get(turn) != "ended"):
            return None
        if aim == "onset":
            t = next((t for t in heard_on if t > first[0]), None)
        else:
            known = next((c[0] for c in cues if c[1] == turn and c[6] is not None), first[0])
            t = next((t for t in heard_off if t > known and ends_turn(t)), None)
        return None if t is None else t + po

    out = {"setting": setting, "playout_ms": po, "turns": dict(sorted(final.items())), "bodies": {}}
    fps = [d["fps"] for d in reports if d.get("fps") is not None]
    out["fps_median"] = statistics.median(fps) if fps else None
    for body in ("avatar", "g1"):
        moves = [m for d in reports for m in ((d.get("kinesics") or {}).get(body) or [])]
        if not moves:
            continue
        mapping = next((d["kinesics"].get("g1Mapping" if body == "g1" else "vrmMapping") for d in reports if d.get("kinesics")), None)
        tg, rows = targets(setting, body, mapping), []
        for m in moves:
            if m["kind"] not in tg or m.get("turn") is None:
                continue
            key, aim, offset = tg[m["kind"]]
            sound = sound_of(m["turn"], aim)
            if sound is None:
                continue
            at = m["startMs"] + (m["durMs"] if key == "end" else 0)
            rows.append({"kind": m["kind"], "turn": m["turn"], "aim": aim, "key": key, "offset_ms": offset,
                         "error_ms": round(at - sound - offset, 1),
                         "clock_error_ms": None if m.get("soundMs") is None else round(m["soundMs"] - sound, 1),
                         "late_start_ms": round(m["startMs"] - m["wantedMs"], 1), "dur_ms": m["durMs"]})
        out["bodies"][body] = {"mapping": mapping, "movements": len(moves), "rows": rows,
                               "late_start_max_ms": max((m["startMs"] - m["wantedMs"] for m in moves), default=None)}
    return out


def summarize(v):
    v = sorted(v)
    return "–" if not v else f"median {statistics.median(v):+.0f} ms, range {v[0]:+.0f} to {v[-1]:+.0f} ms, {sum(abs(x) <= GATE_MS for x in v)} of {len(v)} within {GATE_MS:.0f} ms"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("folder", type=Path)
    ap.add_argument("--json", type=Path)
    a = ap.parse_args(argv)
    client = [json.loads(line) for line in open(a.folder / "client.jsonl")]
    res = analyse(client)
    ends = list(res["turns"].values())
    print(f"Session {a.folder.name}: profile {res['setting']}; {len(ends)} bot turns "
          f"({ends.count('ended')} ended, {ends.count('interrupted')} interrupted, {ends.count('cancelled')} cancelled); "
          f"page at a median {res['fps_median']} frames per second; playout delay added: {res['playout_ms']:.0f} ms")
    if res["fps_median"] is not None and res["fps_median"] < 30:
        print("THE PAGE WAS THROTTLED (hidden or busy): the timing below is not meaningful.")
    for body, b in res["bodies"].items():
        print(f"\n{body} (mapping {b['mapping']}): {b['movements']} movement records; latest start against its plan {b['late_start_max_ms']:.0f} ms")
        print("  movement (key moment, profile offset from the sound)  |  timing error  |  clock error")
        kinds = []
        for r in b["rows"]:
            if r["kind"] not in kinds:
                kinds.append(r["kind"])
        for k in kinds:
            rs = [r for r in b["rows"] if r["kind"] == k]
            r0 = rs[0]
            print(f"  {k} ({r0['key']}, {r0['offset_ms']:+d} ms from the {'first' if r0['aim'] == 'onset' else 'last'} sound)")
            print(f"      timing error: {summarize(r['error_ms'] for r in rs)}")
            print(f"      clock error:  {summarize(r['clock_error_ms'] for r in rs if r['clock_error_ms'] is not None)}")
    if not res["bodies"]:
        print("no kinesics movements in this session's page reports")
    if a.json:
        a.json.write_text(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
