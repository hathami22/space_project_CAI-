from telemetry.channel import SimChannel
from telemetry.codec import Detection, decode_frame, FLAG_CRITICAL, FLAG_RETRANSMIT
from telemetry.hazardmap import MissionMap, det_key
from telemetry.link import LinkConfig, LossyLink
from telemetry.receiver import Receiver
from telemetry.resilient import ResilientSender
from telemetry.sender import Sender


def crater(x=100, y=200, ts=0):
    return Detection(1, 6, x, y, ts, 20)


def test_new_hazard_sent_immediately():
    out = []
    rs = ResilientSender(lambda d, t: out.append((t, d)))
    rs.observe([crater()], 0)
    assert rs.tick(0) == 1
    f = decode_frame(out[0][1])
    assert f is not None and f.flags & FLAG_CRITICAL and not f.flags & FLAG_RETRANSMIT


def test_repeats_are_spaced_then_refresh():
    out = []
    rs = ResilientSender(lambda d, t: out.append((t, d)))
    rs.observe([crater()], 0)
    for t in range(0, 20000, 500):
        rs.tick(t)
    assert [t for t, _ in out] == [0, 1500, 3000, 13000]       # new, 2 repeats, refresh
    assert decode_frame(out[1][1]).flags & FLAG_RETRANSMIT


def test_coalescing_same_cell_sends_once():
    out = []
    rs = ResilientSender(lambda d, t: out.append(d))
    for i in range(100):
        rs.observe([crater(ts=i * 10)], i * 10)
    assert len(rs.entries) == 1
    rs.tick(1000)
    assert len(out) == 1
    assert list(rs.entries.values())[0].det.ts_ms == 990       # latest reading kept


def test_byte_budget_is_respected():
    log = []
    rs = ResilientSender(lambda d, t: log.append((t, len(d))))
    rs.observe([crater(x=i * 200, y=0) for i in range(100)], 0)
    for t in range(0, 120_000, 500):
        rs.tick(t)
    steady = sum(n for t, n in log if 60_000 <= t < 120_000)
    assert steady <= rs.cfg.budget_bps * 60 * 1.1               # <= 40 B/s (+10%)


def test_recovers_after_blackout_while_naive_does_not():
    hazards = [crater(x=i * 500, y=0, ts=1000 * i) for i in range(1, 6)]   # t=1..5 s
    cfg = dict(blackouts=[(1000, 8000)], latency_ms=500)

    mm_n = MissionMap()
    ch_n = SimChannel(LossyLink(LinkConfig(**cfg)), Receiver(on_frame=mm_n.update))
    naive = Sender(ch_n.send)
    mm_r = MissionMap()
    ch_r = SimChannel(LossyLink(LinkConfig(**cfg)), Receiver(on_frame=mm_r.update))
    rs = ResilientSender(ch_r.send)

    by_t = {h.ts_ms: h for h in hazards}
    for t in range(0, 20001, 500):
        h = by_t.get(t)
        if h:
            naive.send([h], t)
            rs.observe([h], t)
        rs.tick(t)
        ch_n.advance(t)
        ch_r.advance(t)
    ch_n.advance(10**9)
    ch_r.advance(10**9)
    keys = {det_key(h) for h in hazards}
    assert len(keys & set(mm_r.cells)) == 5                     # all recovered
    assert len(keys & set(mm_n.cells)) < 5                      # naive lost some


def test_mission_map_keeps_latest_and_reports_age():
    mm = MissionMap()
    d = {"class": "crater", "conf": 5, "x_cm": 100, "y_cm": 200, "sigma_cm": 20}
    assert mm.update({"detections": [{**d, "ts_ms": 1000}], "rx_ms": 1500}) == 1
    assert mm.update({"detections": [{**d, "ts_ms": 3000}], "rx_ms": 3500}) == 0
    assert mm.update({"detections": [{**d, "ts_ms": 500}], "rx_ms": 4000}) == 0   # stale ignored
    (c,) = mm.snapshot(5000)
    assert c["ts_ms"] == 3000 and c["age_ms"] == 2000 and c["first_rx_ms"] == 1500