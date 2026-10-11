"""Live demo: perception -> adapter -> resilient sender -> lossy UDP -> receiver -> WebSocket.

Run from the repo root, then open debug_viewer.html in a browser:
    python run_live.py
    python run_live.py --loss 0.3 --blackout 20:30
"""
import argparse
import asyncio

from telemetry import bridge
from telemetry.perception_adapter import PerceptionRover
from telemetry.perception_live import Perception, load_frames

ap = argparse.ArgumentParser(description="Live telemetry demo with the real detector")
ap.add_argument("--frames", default="data/render", help="folder of images or a video file")
ap.add_argument("--weights", default="best.pt")
ap.add_argument("--n", type=int, default=100, help="how many frames to load")
ap.add_argument("--fps", type=float, default=2.0, help="frames consumed per second (bridge steps at 2/s)")
ap.add_argument("--speed", type=float, default=30.0, help="assumed rover speed, cm/s")
ap.add_argument("--confirm-hits", type=int, default=1,
                help="sightings before a hazard is reported (1 for independent renders, 2 for a real drive)")
ap.add_argument("--loss", type=float, default=0.1)
ap.add_argument("--blackout", action="append", default=[], help="START:END in seconds, repeatable")
ap.add_argument("--seed", type=int, default=1)
a = ap.parse_args()

frames = load_frames(a.frames, n=a.n)
print(f"loaded {len(frames)} frames from {a.frames}")
perception = Perception(a.weights)
rover = PerceptionRover.from_detector(perception.detect_b, frames, fps=a.fps,
                                      speed_cm_s=a.speed, confirm_hits=a.confirm_hits)
blackouts = [tuple(float(x) for x in b.split(":")) for b in a.blackout]
print(f"Bridge up: ws://localhost:8765  loss={a.loss:.0%}  blackouts={blackouts}")
try:
    asyncio.run(bridge.run(rover=rover, loss=a.loss, blackouts=blackouts, seed=a.seed, verbose=True))
except KeyboardInterrupt:
    print("stopped")