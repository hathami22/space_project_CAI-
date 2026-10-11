"""Adapter test: noisy rover-relative detections must not create duplicate hazards."""
import random, math
from telemetry.perception_adapter import PerceptionRover
from telemetry.codec import Detection
from telemetry.channel import SimChannel
from telemetry.hazardmap import MissionMap
from telemetry.link import LinkConfig, LossyLink
from telemetry.receiver import Receiver
from telemetry.resilient import ResilientSender

SPEED = 30.0
def make_world(seed, n=30):
    rng = random.Random(seed)
    return [(rng.choice([0, 0, 1, 2]), rng.uniform(-400, 400), rng.uniform(100, 2800)) for _ in range(n)]

def make_source(world, seed):
    rng = random.Random(seed + 99)
    def source(t_ms):
        ry = SPEED * t_ms / 1000
        out = []
        for cls, x, y in world:
            xr, yr = x, y - ry
            if 100 < yr < 900 and abs(xr) < 450:
                sig = max(3.0, 4.4e-5 * yr * yr)
                out.append(Detection(cls, rng.randrange(3, 8), rng.gauss(xr, sig), rng.gauss(yr, sig), t_ms, sig))
        return out
    return source

def run(seed, loss, tracked):
    world = make_world(seed)
    src = make_source(world, seed)
    rover = PerceptionRover(src, speed_cm_s=SPEED)
    if not tracked:                       # baseline: raw noisy world positions, no tracking/filtering
        rover.step = lambda t, r=rover: ([Detection(d.class_id, d.conf, int(r._to_world(d.x_cm, d.y_cm, t)[0]),
                                                    int(r._to_world(d.x_cm, d.y_cm, t)[1]), t, d.sigma_cm)
                                          for d in src(t)])
    link = LossyLink(LinkConfig.with_avg_loss(loss, bursty=True, blackouts=[(20000, 30000)],
                                              latency_ms=1300, jitter_ms=100, seed=seed))
    mm = MissionMap()
    ch = SimChannel(link, Receiver(on_frame=mm.update))
    rs = ResilientSender(ch.send)
    for t in range(0, 100_001, 500):
        rs.observe(rover.step(t), t); rs.tick(t); ch.advance(t)
    ch.advance(130_000)
    hz = [c for c in mm.cells.values() if c["class"] != "beacon"]
    ghosts = sum(1 for c in hz if min(math.hypot(c["x_cm"] - x, c["y_cm"] - y) for _, x, y in world) > 150)
    seen_truth = sum(1 for _, x, y in world if any(math.hypot(c["x_cm"] - x, c["y_cm"] - y) <= 150 for c in hz))
    return len(hz), ghosts, seen_truth, rs.tx_stats["bytes"]



def _avg(tracked, loss=0.3, seeds=range(10)):
    rows = [run(s, loss, tracked) for s in seeds]
    return [sum(r[i] for r in rows) / len(rows) for i in range(4)]


def test_tracking_removes_duplicates_and_keeps_coverage():
    raw, trk = _avg(False), _avg(True)
    assert trk[0] < 0.6 * raw[0]          # far fewer phantom hazards than raw positions
    assert trk[0] <= 30 * 1.2             # close to the true 30 rocks
    assert trk[2] >= 27                   # and nearly all real rocks reach Mission Control at 30% loss


def test_rover_to_world_rotation():
    r = PerceptionRover(lambda t: [], speed_cm_s=0, heading_deg=90, start_cm=(100, 200))
    # heading east: "forward 50" is +x, "right 30" is -y
    x, y = r._to_world(30, 50, 0)
    assert (round(x), round(y)) == (150, 170)


def test_beacon_cadence():
    r = PerceptionRover(lambda t: [], speed_cm_s=30)
    beacons = sum(1 for t in range(0, 10_001, 500) for d in r.step(t) if d.class_id == 3)
    assert beacons == 6                   # t = 0, 2, 4, 6, 8, 10 s