from telemetry.link import LossyLink, LinkConfig
from telemetry.codec import Detection, encode_frame, decode_frame


def run(cfg, n=20000, step=100):
    """Return (loss fraction, mean length of consecutive-drop runs)."""
    link = LossyLink(cfg)
    runs, cur, lost = [], 0, 0
    for i in range(n):
        if not link.transmit(b"x", i * step):
            lost += 1
            cur += 1
        elif cur:
            runs.append(cur)
            cur = 0
    if cur:
        runs.append(cur)
    return lost / n, (sum(runs) / len(runs) if runs else 0.0)


def test_perfect_link_delivers_everything():
    link = LossyLink(LinkConfig())
    for i in range(100):
        assert link.transmit(b"abc", i) == [(i, b"abc")]


def test_uniform_loss_rate():
    loss, _ = run(LinkConfig(loss_rate=0.3), n=10000)
    assert abs(loss - 0.3) < 0.02


def test_burst_loss_matches_target_and_is_bursty():
    loss, mean_run = run(LinkConfig.with_avg_loss(0.3, bursty=True))
    _, uniform_run = run(LinkConfig.with_avg_loss(0.3, bursty=False))
    assert abs(loss - 0.3) < 0.03
    assert mean_run > 2.5 and mean_run > uniform_run * 1.5


def test_scheduled_blackout_window():
    link = LossyLink(LinkConfig(blackouts=[(1000, 2000)]))
    assert link.transmit(b"x", 999)
    assert not link.transmit(b"x", 1000)
    assert not link.transmit(b"x", 1999)
    assert link.transmit(b"x", 2000)


def test_manual_blackout_switch():
    link = LossyLink(LinkConfig())
    link.set_blackout(True)
    assert not link.transmit(b"x", 0)
    link.set_blackout(False)
    assert link.transmit(b"x", 1)


def test_latency_and_jitter_bounds():
    link = LossyLink(LinkConfig(latency_ms=1000, jitter_ms=200))
    for i in range(500):
        (t, _), = link.transmit(b"x", 5000)
        assert 5800 <= t <= 6200


def test_duplicates():
    link = LossyLink(LinkConfig(dup_rate=1.0))
    assert len(link.transmit(b"x", 0)) == 2


def test_reordering_delays_some_packets():
    link = LossyLink(LinkConfig(reorder_rate=0.5, reorder_extra_ms=300))
    times = [link.transmit(b"x", 0)[0][0] for _ in range(200)]
    assert set(times) == {0, 300}


def test_corruption_is_caught_by_crc():
    frame = encode_frame(1, [Detection(0, 5, 100, 200, 1000, 20)])
    link = LossyLink(LinkConfig(corrupt_rate=1.0))
    for _ in range(200):
        (_, data), = link.transmit(frame, 0)
        assert data != frame
        assert decode_frame(data) is None


def test_deterministic_with_same_seed():
    cfg = dict(loss_rate=0.2, jitter_ms=50, dup_rate=0.1, seed=7)
    a, b = LossyLink(LinkConfig(**cfg)), LossyLink(LinkConfig(**cfg))
    for i in range(1000):
        assert a.transmit(b"x", i) == b.transmit(b"x", i)