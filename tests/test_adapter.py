import json
import math
import random

import pytest

from telemetry.channel import SimChannel
from telemetry.codec import CLASS_BEACON, Detection
from telemetry.hazardmap import MissionMap
from telemetry.link import LinkConfig, LossyLink
from telemetry.perception_adapter import PerceptionRover
from telemetry.receiver import Receiver
from telemetry.resilient import ResilientSender


def rock(x, y, t=0, sigma=20.0, cls=0, conf=5):
    return Detection(cls, conf, x, y, t, sigma)


def hazards(dets):
    return [d for d in dets if d.class_id != CLASS_BEACON]


def test_frame_transform_heading_north_and_east():
    north = PerceptionRover(lambda t: [], speed_cm_s=0, heading_deg=0)
    assert north._to_world(100, 300, 0) == pytest.approx((100, 300))
    east = PerceptionRover(lambda t: [], speed_cm_s=0, heading_deg=90)   # facing east
    assert east._to_world(100, 300, 0) == pytest.approx((300, -100))     # right of east = south


def test_rover_start_offset_and_motion():
    r = PerceptionRover(lambda t: [], speed_cm_s=50, heading_deg=0, start_cm=(10, 20))
    assert r.position(2000) == pytest.approx((10, 120))


def test_two_overlapping_detections_in_ONE_frame_do_not_confirm():
    r = PerceptionRover(lambda t: [rock(100, 300), rock(120, 310)], speed_cm_s=0)
    assert hazards(r.step(0)) == []


def test_confirms_on_second_frame_and_position_is_frozen():
    rng = random.Random(1)
    r = PerceptionRover(lambda t: [rock(100 + rng.gauss(0, 15), 300 + rng.gauss(0, 15), t)],
                        speed_cm_s=0)
    assert hazards(r.step(0)) == []                       # first sighting: not yet reported
    first = hazards(r.step(500))
    assert len(first) == 1
    pos = (first[0].x_cm, first[0].y_cm)
    for k in range(2, 40):
        (d,) = hazards(r.step(k * 500))
        assert (d.x_cm, d.y_cm) == pos                    # never hops across a 1 m cell


def test_sigma_is_not_overconfident():
    r = PerceptionRover(lambda t: [rock(100, 300, t, sigma=40)], speed_cm_s=0)
    for k in range(30):
        out = hazards(r.step(k * 500))
    assert out[0].sigma_cm >= 39                          # 30 sightings do not "average away" error


def test_far_low_quality_detections_are_dropped():
    r = PerceptionRover(lambda t: [rock(100, 1500, t, sigma=150)], speed_cm_s=0)
    for k in range(10):
        assert hazards(r.step(k * 500)) == []


def test_different_classes_are_not_merged():
    r = PerceptionRover(lambda t: [rock(100, 300, t, cls=0), rock(100, 300, t, cls=1)],
                        speed_cm_s=0)
    r.step(0)
    out = hazards(r.step(500))
    assert sorted(d.class_id for d in out) == [0, 1]


def test_beacon_cadence():
    r = PerceptionRover(lambda t: [], speed_cm_s=10, beacon_every_ms=2000)
    ts = [k * 500 for k in range(20) if any(d.class_id == CLASS_BEACON for d in r.step(k * 500))]
    assert ts == [0, 2000, 4000, 6000, 8000]


def test_replay_loop_does_not_grow_the_hazard_count(tmp_path):
    rows = []
    for i in range(100):                                  # 100 frames, 3 fixed-looking rocks
        for j, (x, y) in enumerate([(-150, 350), (80, 420), (200, 300)]):
            rows.append({"class_id": 0, "conf": 5, "x_cm": x + 0.3 * i, "y_cm": y,
                         "ts_ms": i * 100, "sigma_cm": 20})
    p = tmp_path / "d.jsonl"
    p.write_text("\n".join(json.dumps(r) for r in rows))
    r = PerceptionRover.from_jsonl(str(p))
    cells, per_loop = set(), []
    for k in range(600):                                  # 6 passes of the 50 s loop
        for d in hazards(r.step(k * 500)):
            cells.add((d.class_id, d.x_cm // 100, d.y_cm // 100))
        if k % 100 == 99:
            per_loop.append(len(cells))
    assert per_loop[0] == per_loop[-1] and per_loop[0] <= 6


def test_from_detector_loops_pose_with_the_frames():
    frames = [object()] * 10
    r = PerceptionRover.from_detector(lambda f, t: [], frames, fps=2.0, speed_cm_s=30)
    assert r.loop_ms == 5000
    assert r.position(5000) == pytest.approx(r.position(0))


def test_static_world_end_to_end_no_duplicates_and_accurate():
    """Fixed rocks, a moving rover, noisy range-dependent measurements -> one hazard per rock."""
    rng = random.Random(0)
    truth = [(rng.randint(-250, 250), rng.randint(300, 1400)) for _ in range(12)]
    speed = 30

    def source(t):                                        # what A's detector would see
        py = speed * (t % 50_000) / 1000                  # rover drives north, loops every 50 s
        out = []
        for x, y in truth:
            ry = y - py
            if 120 < ry < 900:
                s = 5 + 2 * ry * ry / (100 * 457)         # A's depth-error model
                out.append(rock(x + rng.gauss(0, s / 2), ry + rng.gauss(0, s / 2), t, sigma=s))
        return out

    rov = PerceptionRover(source, speed_cm_s=speed, loop_ms=50_000)
    mm = MissionMap()
    ch = SimChannel(LossyLink(LinkConfig()), Receiver(on_frame=mm.update))
    rs = ResilientSender(ch.send)
    for t in range(0, 200_000, 500):                      # 4 passes
        rs.observe(rov.step(t), t)
        rs.tick(t)
        ch.advance(t)
    ch.advance(300_000)
    found = [c for c in mm.cells.values() if c["class"] != "beacon"]
    assert len(found) <= len(truth)                       # no duplicate hazards
    assert len(found) >= len(truth) - 1                   # (almost) every rock reported
    for c in found:                                       # reported position within 1 m of truth
        assert min(math.hypot(c["x_cm"] - x, c["y_cm"] - y) for x, y in truth) < 100
    assert rs.tx_stats["bytes"] / 200 < 40                # well under the 40 B/s budget