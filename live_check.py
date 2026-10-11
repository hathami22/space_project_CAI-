#!/usr/bin/env python3
"""Live check: does the real perception -> adapter pipeline give a STABLE hazard map?

Runs A's detector over real frames with a simulated clock (no waiting, no sockets), loops
the frames several times and prints how many hazards exist after each pass.
Expected: the count rises during pass 1, then levels off.

    python live_check.py --frames data/render --model best.pt
    python live_check.py --frames data/render --no-model            # classical CV only, no torch
    python live_check.py --frames data/render --model best.pt --speeds 0,15,30
    python live_check.py --frames data/render --model best.pt --confirm-hits 1
    python live_check.py --frames data/render --model best.pt --serve --blackout 20:30
        (after the check, serves the same pipeline on ws://localhost:8765 for the dashboard)
"""
import argparse
import asyncio
import statistics
import sys
import time

from telemetry.codec import CLASS_BEACON
from telemetry.perception_adapter import PerceptionRover
from telemetry.perception_live import boxes_to_detections, classical_detect, load_frames

STEP_MS = 500       # bridge step; PerceptionRover assumes fps = 1000 / STEP_MS = 2


def make_detector(model, device):
    if model:
        from telemetry.perception_live import Perception
        return Perception(model, device=device).detect_b
    return lambda f, t: boxes_to_detections(classical_detect(f), f.shape[:2], t)


def check(frames, detect, speed, passes, confirm_hits=2):
    stats = {"raw": 0, "kept": 0, "ms": []}
    box = {}

    def counted(f, t):
        t0 = time.perf_counter()
        dets = detect(f, t)
        stats["ms"].append((time.perf_counter() - t0) * 1000)
        stats["raw"] += len(dets)
        stats["kept"] += sum(1 for d in dets if d.sigma_cm <= box["rover"].max_sigma)
        return dets

    box["rover"] = rover = PerceptionRover.from_detector(counted, frames, fps=1000 / STEP_MS,
                                                         speed_cm_s=speed,
                                                         confirm_hits=confirm_hits)
    cells, per_pass = set(), []
    n = len(frames)
    for k in range(passes * n):
        for d in rover.step(k * STEP_MS):
            if d.class_id != CLASS_BEACON:
                cells.add((d.class_id, d.x_cm // 100, d.y_cm // 100))
        if (k + 1) % n == 0:
            per_pass.append(len(cells))
    return per_pass, stats, rover


def verdict(per_pass):
    first, last = per_pass[0], per_pass[-1]
    new_late = last - per_pass[-2] if len(per_pass) > 1 else 0
    if first == 0:
        return "NO HAZARDS", "nothing was confirmed (see raw/kept counts above)"
    if new_late <= max(2, round(0.1 * first)):
        return "STABLE", "the map levels off after the first pass"
    return "STILL GROWING", f"{new_late} new hazards in the last pass"


def serve(make_rover, args):
    from telemetry import bridge
    blackouts = [tuple(float(x) for x in b.split(":")) for b in args.blackout]
    print(f"\nServing ws://localhost:8765  loss={args.loss:.0%}  blackouts={blackouts}")
    print("Open telemetry/debug_viewer.html (or C's dashboard). Ctrl+C to stop.")
    try:
        asyncio.run(bridge.run(loss=args.loss, blackouts=blackouts, step_ms=STEP_MS,
                               rover=make_rover(), verbose=True, duration_s=args.serve_seconds))
    except KeyboardInterrupt:
        print("stopped")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--frames", required=True, help="folder of images or a video file")
    ap.add_argument("--model", default="best.pt", help="YOLO weights (Person A's best.pt)")
    ap.add_argument("--no-model", action="store_true", help="classical CV only (no torch needed)")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--n", type=int, default=100, help="frames to load")
    ap.add_argument("--passes", type=int, default=4)
    ap.add_argument("--speed", type=float, default=30.0, help="rover speed, cm/s")
    ap.add_argument("--speeds", help="comma list to compare, e.g. 0,15,30")
    ap.add_argument("--confirm-hits", type=int, default=1,
                    help="frames a hazard must be seen in before it is reported (default 2)")
    ap.add_argument("--serve", action="store_true")
    ap.add_argument("--serve-seconds", type=float, default=None)
    ap.add_argument("--loss", type=float, default=0.1)
    ap.add_argument("--blackout", action="append", default=[])
    a = ap.parse_args()

    frames = load_frames(a.frames, n=a.n)
    detect = make_detector(None if a.no_model else a.model, a.device)
    speeds = [float(s) for s in a.speeds.split(",")] if a.speeds else [a.speed]
    print(f"{len(frames)} frames, {a.passes} passes, detector = "
          f"{'classical CV only' if a.no_model else a.model}\n")

    ok = True
    for sp in speeds:
        per_pass, st, rover = check(frames, detect, sp, a.passes, a.confirm_hits)
        name, why = verdict(per_pass)
        ok &= name == "STABLE"
        calls = len(st["ms"])
        print(f"speed {sp:g} cm/s")
        print(f"  hazards after each pass : {per_pass}")
        print(f"  raw detections / frame  : {st['raw'] / calls:.1f}   kept (sigma <= {rover.max_sigma:g} cm): "
              f"{st['kept'] / calls:.1f}")
        print(f"  perception latency      : {statistics.mean(st['ms']):.0f} ms/frame "
              f"({1000 / statistics.mean(st['ms']):.0f} fps)")
        print(f"  verdict                 : {name} - {why}\n")

    if not ok:
        print("Tips: STILL GROWING -> try a lower --speed (a mismatch between the scripted pose and the\n"
              "      dataset camera smears one rock across several cells). NO HAZARDS -> check --frames\n"
              "      and the 'kept' count: far detections above 60 cm sigma are dropped on purpose.")
    if a.serve:
        serve(lambda: PerceptionRover.from_detector(detect, frames, fps=1000 / STEP_MS,
                                                    speed_cm_s=a.speed,
                                                    confirm_hits=a.confirm_hits), a)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()