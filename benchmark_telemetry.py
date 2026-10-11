#!/usr/bin/env python3
"""Telemetry benchmark.  Writes results/telemetry_benchmark.json, .md and pytest_output.txt

    python benchmark_telemetry.py            full run (30 seeds)
    python benchmark_telemetry.py --quick    8 seeds, a few seconds
    python benchmark_telemetry.py --skip-tests

What is measured (all deterministic: seeded RNGs, simulated clock, no network):
  1. Frame size: binary frame vs JSON (default and minified), 1..32 detections per frame.
  2. Codec speed: encode+decode frames per second on this machine.
  3. Delivery: share of hazards Mission Control knows at the end, naive vs resilient,
     at 0/10/30/50 % burst loss, with two blackouts (see telemetry/compare.py).
  4. Blackout recovery (definition below), naive vs resilient.
  5. The pytest suite result.

BLACKOUT RECOVERY - definition
  One 10 s blackout, t = 20..30 s. "Blackout hazards" = hazards the rover discovered
  during it (their first transmission is lost for sure).
    recovered_pct  share of blackout hazards that EVER reached Mission Control
    first_s        seconds from the END of the blackout until the first one arrives
    t90_s          seconds from the END of the blackout until >= 90 % of them are known
                   (None = never reached; reported with the share of runs that reached it)
  Medians are taken over seeds that reached the milestone.
"""
import argparse
import json
import math
import os
import platform
import random
import statistics
import subprocess
import sys
import time

from telemetry.channel import SimChannel
from telemetry.codec import CLASS_NAMES, Detection, decode_frame, encode_frame
from telemetry.compare import aggregate
from telemetry.hazardmap import MissionMap, det_key
from telemetry.link import LinkConfig, LossyLink
from telemetry.receiver import Receiver
from telemetry.resilient import ResilientSender
from telemetry.sender import Sender
from telemetry.sim_demo import make_dets

LOSSES = (0.0, 0.1, 0.3, 0.5)
BLACKOUT = (20_000, 30_000)
STEP_MS = 500


# --- 1. frame size ----------------------------------------------------------
def json_size(d, minified):
    obj = {"seq": 0, "timestamp": d.ts_ms, "class": CLASS_NAMES[d.class_id],
           "confidence": round(d.conf / 7, 2), "x": d.x_cm / 100, "y": d.y_cm / 100,
           "uncertainty_m": round(d.sigma_cm / 100, 2)}
    return len(json.dumps(obj, separators=(",", ":") if minified else None).encode())


def frame_sizes(samples=200):
    rows = []
    for n in (1, 2, 4, 8, 16, 32):
        rng = random.Random(n)
        b = jd = jm = 0
        for _ in range(samples):
            dets = make_dets(rng, 1000, n)
            b += len(encode_frame(0, dets))
            jd += sum(json_size(d, False) for d in dets)
            jm += sum(json_size(d, True) for d in dets)
        b, jd, jm = b / samples, jd / samples, jm / samples
        rows.append({"detections_per_frame": n, "binary_bytes": round(b, 1),
                     "binary_bytes_per_det": round(b / n, 1),
                     "json_bytes": round(jd, 1), "json_minified_bytes": round(jm, 1),
                     "ratio_vs_json": round(jd / b, 1), "ratio_vs_minified_json": round(jm / b, 1)})
    return rows


# --- 2. codec speed ---------------------------------------------------------
def codec_speed(frames=20000):
    rng = random.Random(0)
    dets = make_dets(rng, 1000, 4)
    t0 = time.perf_counter()
    for i in range(frames):
        data = encode_frame(i, dets)
    enc = time.perf_counter() - t0
    t0 = time.perf_counter()
    for _ in range(frames):
        assert decode_frame(data) is not None
    dec = time.perf_counter() - t0
    return {"frame": "4 detections, 38 B", "encode_frames_per_s": int(frames / enc),
            "decode_frames_per_s": int(frames / dec)}


# --- 3. delivery ------------------------------------------------------------
def delivery(seeds):
    rows = []
    for loss in LOSSES:
        n = aggregate("naive", loss, seeds)
        r = aggregate("resilient", loss, seeds)
        rows.append({"loss": loss, "naive": n, "resilient": r})
    return rows


# --- 4. blackout recovery ---------------------------------------------------
def make_hazards(seed, last_ms=55_000, every_ms=1500):
    rng = random.Random(seed)
    out, seen = [], set()
    for t in range(0, last_ms + 1, every_ms):
        while True:
            d = Detection(rng.choice([0, 0, 1, 2]), rng.randrange(3, 8),
                          rng.randint(-3000, 3000), rng.randint(-3000, 3000),
                          t, rng.uniform(10, 300))
            if det_key(d) not in seen:
                seen.add(det_key(d))
                break
        out.append(d)
    return out


def recovery_run(strategy, loss, seed, total_ms=90_000):
    bs, be = BLACKOUT
    hazards = make_hazards(seed)
    by_t = {h.ts_ms: h for h in hazards}
    link = LossyLink(LinkConfig.with_avg_loss(loss, bursty=True, blackouts=[BLACKOUT],
                                              latency_ms=1300, jitter_ms=100, seed=seed))
    mm = MissionMap()
    chan = SimChannel(link, Receiver(on_frame=mm.update))
    naive = Sender(chan.send) if strategy == "naive" else None
    resil = ResilientSender(chan.send) if strategy == "resilient" else None
    for t in range(0, total_ms + 1, STEP_MS):
        h = by_t.get(t)
        if naive:
            if h:
                naive.send([h], t)
        else:
            if h:
                resil.observe([h], t)
            resil.tick(t)
        chan.advance(t)
    chan.advance(total_ms + 30_000)
    inside = [h for h in hazards if bs <= h.ts_ms < be]
    arrivals = sorted(mm.cells[det_key(h)]["first_rx_ms"] - be
                      for h in inside if det_key(h) in mm.cells)
    need = math.ceil(0.9 * len(inside))
    return {"n": len(inside), "recovered": len(arrivals) / len(inside),
            "first_s": arrivals[0] / 1000 if arrivals else None,
            "t90_s": arrivals[need - 1] / 1000 if len(arrivals) >= need else None}


def blackout_recovery(seeds):
    rows = []
    for loss in (0.0, 0.1, 0.3):
        row = {"loss": loss}
        for strategy in ("naive", "resilient"):
            runs = [recovery_run(strategy, loss, s) for s in seeds]
            firsts = [r["first_s"] for r in runs if r["first_s"] is not None]
            t90 = [r["t90_s"] for r in runs if r["t90_s"] is not None]
            row[strategy] = {
                "blackout_hazards_per_run": round(statistics.mean(r["n"] for r in runs), 1),
                "recovered_pct": round(100 * statistics.mean(r["recovered"] for r in runs), 1),
                "first_s": round(statistics.median(firsts), 1) if firsts else None,
                "t90_s": round(statistics.median(t90), 1) if t90 else None,
                "runs_reaching_t90_pct": round(100 * len(t90) / len(runs)),
            }
        rows.append(row)
    return rows


# --- 5. pytest --------------------------------------------------------------
def run_pytest():
    p = subprocess.run([sys.executable, "-m", "pytest", "-q", "--tb=short"],
                       capture_output=True, text=True)
    out = p.stdout + p.stderr
    os.makedirs("results", exist_ok=True)
    with open("results/pytest_output.txt", "w") as fh:
        fh.write(out)
    last = [ln for ln in out.strip().splitlines() if ln.strip()][-1] if out.strip() else ""
    return {"exit_code": p.returncode, "summary": last}


# --- report -----------------------------------------------------------------
def pct(v):
    return "-" if v is None else f"{100 * v:.1f}%"


def fmt(v, unit=""):
    return "never" if v is None else f"{v}{unit}"


def markdown(res):
    L = [f"# Telemetry benchmark ({res['generated']})", "",
         f"Seeds: {res['seeds']}. Python {res['python']}, {res['platform']}. "
         "Deterministic: seeded RNGs and a simulated clock.", "",
         "## 1. Frame size: binary vs JSON", "",
         "| detections/frame | binary B | B/detection | JSON B | minified JSON B | x smaller (JSON) | x smaller (minified) |",
         "|---|---|---|---|---|---|---|"]
    for r in res["frame_sizes"]:
        L.append(f"| {r['detections_per_frame']} | {r['binary_bytes']} | {r['binary_bytes_per_det']} | "
                 f"{r['json_bytes']} | {r['json_minified_bytes']} | {r['ratio_vs_json']}x | "
                 f"{r['ratio_vs_minified_json']}x |")
    c = res["codec_speed"]
    L += ["", f"Codec speed ({c['frame']}): encode {c['encode_frames_per_s']:,} frames/s, "
              f"decode {c['decode_frames_per_s']:,} frames/s (single core, pure Python).", "",
          "## 2. Delivery: hazards known to Mission Control at the end", "",
          "Burst loss (Gilbert-Elliott), 1.3 s one-way latency, two blackouts (17 s of 90 s).", "",
          "| link loss | naive | resilient | bytes/s naive | bytes/s resilient |", "|---|---|---|---|---|"]
    for r in res["delivery"]:
        n, s = r["naive"], r["resilient"]
        L.append(f"| {r['loss']:.0%} | {pct(n['coverage'])} | {pct(s['coverage'])} | "
                 f"{n['bytes_per_s']:.1f} | {s['bytes_per_s']:.1f} |")
    L += ["", "## 3. Blackout recovery (10 s blackout at t = 20-30 s)", "",
          "Hazards discovered DURING the blackout. Times are measured from the END of the blackout.", "",
          "| link loss | strategy | recovered | first arrives | 90 % known | runs reaching 90 % |",
          "|---|---|---|---|---|---|"]
    for r in res["blackout_recovery"]:
        for k in ("naive", "resilient"):
            v = r[k]
            L.append(f"| {r['loss']:.0%} | {k} | {v['recovered_pct']}% | {fmt(v['first_s'], ' s')} | "
                     f"{fmt(v['t90_s'], ' s')} | {v['runs_reaching_t90_pct']}% |")
    L += ["", "## 4. Test suite", "", f"`pytest`: {res['pytest']['summary']} "
          "(full output in results/pytest_output.txt)", ""]
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="8 seeds instead of 30")
    ap.add_argument("--skip-tests", action="store_true")
    a = ap.parse_args()
    seeds = range(8 if a.quick else 30)
    t0 = time.time()
    res = {"generated": time.strftime("%Y-%m-%d %H:%M"), "seeds": len(seeds),
           "python": platform.python_version(), "platform": platform.platform()}
    print("1/5 frame sizes ...", flush=True)
    res["frame_sizes"] = frame_sizes()
    print("2/5 codec speed ...", flush=True)
    res["codec_speed"] = codec_speed()
    print("3/5 delivery vs loss ...", flush=True)
    res["delivery"] = delivery(seeds)
    print("4/5 blackout recovery ...", flush=True)
    res["blackout_recovery"] = blackout_recovery(seeds)
    print("5/5 pytest ...", flush=True)
    res["pytest"] = {"exit_code": None, "summary": "skipped"} if a.skip_tests else run_pytest()
    os.makedirs("results", exist_ok=True)
    with open("results/telemetry_benchmark.json", "w") as fh:
        json.dump(res, fh, indent=2)
    md = markdown(res)
    with open("results/telemetry_benchmark.md", "w") as fh:
        fh.write(md)
    print(md)
    print(f"\nsaved results/telemetry_benchmark.json, .md, pytest_output.txt  ({time.time() - t0:.0f} s)")
    if res["pytest"]["exit_code"]:
        sys.exit(res["pytest"]["exit_code"])


if __name__ == "__main__":
    main()