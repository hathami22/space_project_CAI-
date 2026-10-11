import asyncio
from telemetry.channel import SimChannel
from telemetry.codec import Detection, encode_frame, MAX_DETECTIONS
from telemetry.link import LinkConfig, LossyLink
from telemetry.receiver import Receiver
from telemetry.sender import Sender
from telemetry.udp import MissionClock, open_udp_transport, start_receiver


def det(t=1000):
    return Detection(0, 5, 100, 200, t, 20)


def frame(seq):
    return encode_frame(seq, [det()])


def test_loss_detected_from_seq_gap():
    rx = Receiver()
    for s in (0, 1, 2, 4):
        rx.on_packet(frame(s), 0)
    assert rx.expected == 5 and rx.lost == 1 and rx.stats["unique"] == 4


def test_duplicate_dropped():
    got = []
    rx = Receiver(on_frame=got.append)
    rx.on_packet(frame(0), 0)
    assert rx.on_packet(frame(0), 1) is None
    assert len(got) == 1 and rx.stats["duplicates"] == 1


def test_reordered_frame_still_delivered():
    got = []
    rx = Receiver(on_frame=got.append)
    for s in (0, 2, 1):
        rx.on_packet(frame(s), 0)
    assert [f["seq"] for f in got] == [0, 2, 1]
    assert rx.lost == 0 and rx.stats["reordered"] == 1


def test_seq_wraparound_not_counted_as_loss():
    rx = Receiver()
    for s in (65533, 65534, 65535, 0, 1):
        rx.on_packet(frame(s), 0)
    assert rx.lost == 0 and rx.expected == 5


def test_corrupt_frame_counted_not_delivered():
    got = []
    rx = Receiver(on_frame=got.append)
    bad = bytearray(frame(0))
    bad[5] ^= 0xFF
    assert rx.on_packet(bytes(bad), 0) is None
    assert rx.stats["crc_fail"] == 1 and not got


def test_link_status_contact_time():
    rx = Receiver()
    assert rx.link_status(500)["since_last_rx_ms"] is None
    rx.on_packet(frame(0), 1000)
    assert rx.link_status(4000)["since_last_rx_ms"] == 3000


def test_memory_is_bounded():
    rx = Receiver(window=256)
    for s in range(5000):
        rx.on_packet(frame(s & 0xFFFF), 0)
    assert len(rx._seen) <= 256 and rx.lost == 0


def test_sender_splits_large_batches():
    out = []
    tx = Sender(lambda d, t: out.append(d))
    n = tx.send([det() for _ in range(MAX_DETECTIONS + 5)], 0)
    assert n == 2 and len(out) == 2 and tx.seq == 2


def test_sim_channel_respects_latency():
    rx = Receiver()
    ch = SimChannel(LossyLink(LinkConfig(latency_ms=1000)), rx)
    ch.send(frame(0), 0)
    ch.advance(999)
    assert rx.stats["unique"] == 0
    ch.advance(1000)
    assert rx.stats["unique"] == 1


def test_end_to_end_loss_estimate_matches_truth():
    link = LossyLink(LinkConfig.with_avg_loss(0.3, bursty=True, latency_ms=500, seed=3))
    rx = Receiver()
    ch = SimChannel(link, rx)
    tx = Sender(ch.send)
    for i in range(3000):
        tx.send([det(i * 100)], i * 100)
        ch.advance(i * 100)
    ch.advance(10**9)
    assert abs(rx.loss_fraction() - link.loss_fraction()) < 0.02
    assert 0.2 < rx.loss_fraction() < 0.4


def test_udp_loopback():
    async def main():
        got = []
        rx = Receiver(on_frame=got.append)
        clock = MissionClock()
        server = await start_receiver(rx, "127.0.0.1", 0, clock.now_ms)
        port = server.get_extra_info("sockname")[1]
        tx_t = await open_udp_transport(LossyLink(LinkConfig(latency_ms=50)), "127.0.0.1", port)
        sender = Sender(tx_t.send)
        for _ in range(5):
            sender.send([det(clock.now_ms())], clock.now_ms())
        await asyncio.sleep(0.4)
        server.close()
        tx_t.transport.close()
        return got
    got = asyncio.run(main())
    assert len(got) == 5