"""Adapter: Person A's rover-relative detections -> world-frame Detections for the telemetry stack.

A's detect_b() reports positions RELATIVE TO THE ROVER (+x right/east, +y forward/north, cm).
Mission Control needs positions relative to the landing-site ORIGIN, so this adapter:
  1. dead-reckons the rover pose (constant speed + heading; swap in real odometry if you get it),
  2. rotates/translates each detection into the world frame,
  3. drops far-range detections (large sigma) that are too inaccurate to trust,
  4. tracks hazards so one physical rock keeps ONE fixed reported position
     (otherwise noisy positions hop across 1 m cells and show up as duplicate hazards),
  5. emits a beacon (rover position) every few seconds for the dashboard's rover trail.

Replay/loop behaviour: when the frame source is finite (a jsonl file or a list of frames) it
loops. The rover pose loops with it (loop_ms), so every pass retraces the same route and the
same rocks land on the same world coordinates. Without this, each pass would "discover" a new
set of rocks and the hazard count would grow forever.

Usage with the live bridge (it only needs an object with .step(t_ms)):
    rover = PerceptionRover.from_jsonl("detections_for_B.jsonl")          # no torch needed
    rover = PerceptionRover.from_detector(detect_b, frames)               # live YOLO + rules
    asyncio.run(bridge.run(rover=rover))
"""
import json
import math
from collections import defaultdict
from typing import Callable, List

from .codec import Detection, CLASS_BEACON


class _Track:
    __slots__ = ("cls", "x", "y", "sigma", "conf", "hits", "frozen_xy", "last_step")

    def __init__(self, cls, x, y, sigma, conf):
        self.cls, self.x, self.y, self.sigma, self.conf = cls, x, y, sigma, conf
        self.hits = 1               # number of FRAMES in which this hazard was seen
        self.frozen_xy = None       # reported position, fixed once the track is confirmed
        self.last_step = -1


class PerceptionRover:
    def __init__(self, source: Callable[[int], List[Detection]], speed_cm_s=30.0,
                 heading_deg=0.0, start_cm=(0.0, 0.0), max_sigma_cm=60.0, gate_cm=60.0,
                 confirm_hits=2, beacon_every_ms=2000, max_tracks=1024, loop_ms=None):
        self.source = source                # source(t_ms) -> rover-relative codec.Detection list
        self.speed, self.heading = speed_cm_s, heading_deg
        self.x0, self.y0 = start_cm
        self.max_sigma, self.gate, self.confirm = max_sigma_cm, gate_cm, confirm_hits
        self.beacon_every_ms, self.max_tracks = beacon_every_ms, max_tracks
        self.loop_ms = loop_ms              # pose repeats every loop_ms (None = never)
        self.tracks: List[_Track] = []
        self._last_beacon = -10**9
        self._step = 0

    # --- rover pose (heading 0 = +y/north, clockwise positive) -------------
    def position(self, t_ms):
        if self.loop_ms:
            t_ms = t_ms % self.loop_ms
        d, th = self.speed * t_ms / 1000, math.radians(self.heading)
        return self.x0 + d * math.sin(th), self.y0 + d * math.cos(th)

    def _to_world(self, x_rel, y_rel, t_ms):
        px, py = self.position(t_ms)
        th = math.radians(self.heading)
        return (px + x_rel * math.cos(th) + y_rel * math.sin(th),
                py - x_rel * math.sin(th) + y_rel * math.cos(th))

    # --- tracking ----------------------------------------------------------
    def _match(self, cls, x, y, sigma):
        """Nearest same-class track inside a 3-sigma gate (2-D, so ~99% of true re-sightings)."""
        best, best_d = None, None
        for t in self.tracks:
            if t.cls != cls:
                continue
            gate = min(max(self.gate, 3 * math.hypot(t.sigma, sigma)), 200.0)
            d = math.hypot(t.x - x, t.y - y)
            if d <= gate and (best_d is None or d < best_d):
                best, best_d = t, d
        return best

    def step(self, t_ms: int) -> List[Detection]:
        """Same contract as FakeRover.step(): detections to report at mission time t_ms."""
        out = []
        self._step += 1
        if t_ms - self._last_beacon >= self.beacon_every_ms:
            bx, by = self.position(t_ms)
            out.append(Detection(CLASS_BEACON, 7, int(bx), int(by), t_ms, 10.0))
            self._last_beacon = t_ms

        reported = set()
        for d in self.source(t_ms):
            if d.sigma_cm > self.max_sigma:
                continue                                    # too far away to trust
            wx, wy = self._to_world(d.x_cm, d.y_cm, t_ms)
            tr = self._match(d.class_id, wx, wy, d.sigma_cm)
            if tr is None:
                tr = _Track(d.class_id, wx, wy, d.sigma_cm, d.conf)
                self.tracks.append(tr)
                if len(self.tracks) > self.max_tracks:      # bounded memory
                    self.tracks.pop(0)
            else:                                           # inverse-variance fusion
                w_old, w_new = 1 / tr.sigma ** 2, 1 / d.sigma_cm ** 2
                tr.x = (tr.x * w_old + wx * w_new) / (w_old + w_new)
                tr.y = (tr.y * w_old + wy * w_new) / (w_old + w_new)
                # Errors of re-sightings are NOT independent (same camera model, same pose
                # estimate), so 1/sqrt(n) shrinkage would be over-confident. Keep the best
                # single sighting's sigma (closest range = smallest error) instead.
                tr.sigma = min(tr.sigma, d.sigma_cm)
                tr.conf = max(tr.conf, d.conf)
            if tr.last_step != self._step:                  # count each FRAME once
                if tr.last_step >= 0:
                    tr.hits += 1
                tr.last_step = self._step
            if tr.hits >= self.confirm and id(tr) not in reported:
                if tr.frozen_xy is None:
                    tr.frozen_xy = (int(round(tr.x)), int(round(tr.y)))
                reported.add(id(tr))
                out.append(Detection(tr.cls, tr.conf, tr.frozen_xy[0], tr.frozen_xy[1],
                                     t_ms, max(tr.sigma, 5.0)))
        return out

    # --- constructors ------------------------------------------------------
    @classmethod
    def from_jsonl(cls, path, fps=2.0, frame_ms=100, **kw):
        """Replay A's detections_for_B.jsonl (one frame per bridge step at fps=2)."""
        frames, last = defaultdict(list), 0
        with open(path) as fh:
            for line in fh:
                r = json.loads(line)
                frames[r["ts_ms"]].append(Detection(
                    int(r["class_id"]), int(r["conf"]), float(r["x_cm"]), float(r["y_cm"]),
                    int(r["ts_ms"]), float(r["sigma_cm"])))
                last = max(last, r["ts_ms"])
        n = last // frame_ms + 1
        kw.setdefault("loop_ms", int(n * 1000 / fps))       # one pass = n frames

        def source(t_ms):
            return frames.get((int(t_ms / 1000 * fps) % n) * frame_ms, [])
        return cls(source, **kw)

    @classmethod
    def from_detector(cls, detect_fn, frames, fps=2.0, **kw):
        """Run A's detect_b(frame, t_ms) live over a list of preloaded BGR frames."""
        kw.setdefault("loop_ms", int(len(frames) * 1000 / fps))

        def source(t_ms):
            f = frames[int(t_ms / 1000 * fps) % len(frames)]
            return [Detection(int(d.class_id), int(d.conf), float(d.x_cm), float(d.y_cm),
                              t_ms, float(d.sigma_cm)) for d in detect_fn(f, t_ms)]
        return cls(source, **kw)