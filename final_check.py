"""Final verification of the telemetry stack (Person B). Run from the repo root:

    python final_check.py

Exit code 0 = everything passed. The log is saved to results/final_check.txt
(commit it: it is part of the 'automated test outputs').
"""
import asyncio
import math
import os
import random
import struct
import sys
import time
import traceback

from telemetry import codec
from telemetry.channel import SimChannel
from telemetry.codec import Detection, decode_frame, encode_frame
from telemetry.hazardmap import MissionMap
from telemetry.link import LinkConfig, LossyLink
from telemetry.receiver import Receiver
from telemetry.resilient import ResilientSender
from telemetry.sender import Sender

RESULTS = []


def check(name):
    def deco(fn):
        t0 = time.time()
        try:
            note = fn()
            RESULTS.append((name, True, note or "", time.time() - t0))
        except SkipCheck as e:
            RESULTS.append((name, None, str(e), time.time() - t0))
        except Exception as e:                      # noqa: BLE001
            RESULTS.append((name, False, f"{type(e).__name__}: {e}\n{traceback.format_exc(limit=3)}",
                            time.time() - t0))
        return fn
    return deco


class SkipCheck(Exception):
    pass


def det(cls=0, conf=5, x=100, y=-200, ts=1000, sigma=50.0):
    return Detection(cls, conf, x, y, ts, sigma)


def feed(rx, frames_by_seq, order):
    for s in order:
        rx.on_packet(frames_by_seq[s], 1000 + s)


# ============================ 1. CODEC =======================================
@check("codec: round trip preserves every field")
def _():
    d = det(cls=2, conf=5, x=-1234, y=3000, ts=1000, sigma=50)
    f = decode_frame(encode_frame(7, [d], flags=codec.FLAG_CRITICAL))
    g = f.detections[0]
    assert (f.seq, f.flags) == (7, codec.FLAG_CRITICAL)
    assert (g.class_id, g.conf, g.x_cm, g.y_cm, g.ts_ms) == (2, 5, -1234, 3000, 1000)
    assert abs(g.sigma_cm - 50) / 50 < 0.03, g.sigma_cm
    return f"sigma error {abs(g.sigma_cm - 50) / 50:.1%}"


@check("codec: frame sizes are 17 B (1 det), +7 B per extra, 234 B max")
def _():
    one = len(encode_frame(0, [det()]))
    two = len(encode_frame(0, [det(), det()]))
    full = len(encode_frame(0, [det() for _ in range(32)]))
    assert (one, two - one, full) == (17, 7, 234), (one, two - one, full)
    return "17 / +7 / 234 B"


@check("codec: a single flipped bit ANYWHERE is rejected (CRC)")
def _():
    data = bytearray(encode_frame(5, [det(), det(ts=1300)]))
    for i in range(len(data) * 8):
        bad = bytearray(data)
        bad[i // 8] ^= 1 << (i % 8)
        assert decode_frame(bytes(bad)) is None, f"bit {i} slipped through"
    return f"{len(data) * 8} bit positions tested"


@check("codec: truncated / empty / garbage / wrong-version data returns None")
def _():
    data = encode_frame(1, [det()])
    assert decode_frame(b"") is None and decode_frame(data[:5]) is None and decode_frame(data[:-1]) is None
    assert decode_frame(os.urandom(17)) is None
    body = bytearray(data[:-2])
    body[0] = (2 << 4)                                  # version 2
    assert decode_frame(bytes(body) + struct.pack(">H", codec.crc16(bytes(body)))) is None


@check("codec: timestamps in a batch are accurate to 100 ms, values clamp safely")
def _():
    ds = [det(ts=1000), det(ts=1250, x=99999, y=-99999, sigma=1), det(ts=2000, sigma=99999)]
    f = decode_frame(encode_frame(1, ds))
    assert all(abs(a.ts_ms - b.ts_ms) < 100 for a, b in zip(ds, f.detections))
    assert (f.detections[1].x_cm, f.detections[1].y_cm) == (32767, -32768)
    assert f.detections[1].sigma_cm == codec.SIGMA_MIN_CM and abs(f.detections[2].sigma_cm - 5000) < 1


@check("codec: 0 detections rejected; sender splits 33 detections into 2 frames")
def _():
    try:
        encode_frame(0, [])
        raise AssertionError("empty frame accepted")
    except ValueError:
        pass
    sent = []
    s = Sender(lambda d, t: sent.append(d))
    assert s.send([det(x=i) for i in range(33)], 0) == 2
    assert [decode_frame(p).seq for p in sent] == [0, 1]


@check("codec: binary is >= 8x smaller than the JSON baseline")
def _():
    from telemetry import sim_demo
    r = sim_demo.run(0.0)
    ratio = r["json_bytes"] / r["bin_bytes"]
    assert ratio >= 8, ratio
    return f"JSON {r['json_bytes']} B vs binary {r['bin_bytes']} B = {ratio:.1f}x"


# ============================ 2. LOSSY LINK ==================================
def _trace(seed, n=500):
    link = LossyLink(LinkConfig(loss_rate=0.2, latency_ms=100, jitter_ms=30, dup_rate=0.1,
                                reorder_rate=0.1, corrupt_rate=0.05, seed=seed))
    return [link.transmit(bytes([i % 256]) * 20, i * 100) for i in range(n)]


@check("link: same seed -> identical run; different seed -> different run")
def _():
    assert _trace(42) == _trace(42)
    assert _trace(42) != _trace(43)


@check("link: blackout drops 100% inside the window and recovers right after")
def _():
    link = LossyLink(LinkConfig(blackouts=[(1000, 2000)], seed=1))
    assert all(link.transmit(b"x", t) == [] for t in range(1000, 2000, 10))
    assert all(len(link.transmit(b"x", t)) == 1 for t in (999, 2000, 2500))
    link.set_blackout(True)
    assert link.transmit(b"x", 5000) == []


@check("link: bursty average loss hits the requested rate (+-3 points)")
def _():
    out = []
    for target in (0.1, 0.3, 0.5):
        link = LossyLink(LinkConfig.with_avg_loss(target, bursty=True, seed=7))
        for i in range(30000):
            link.transmit(b"x", i)
        got = link.loss_fraction()
        assert abs(got - target) < 0.03, (target, got)
        out.append(f"{target:.0%}->{got:.1%}")
    return ", ".join(out)


@check("link: duplicates and reordering happen; delay stays within latency +- jitter")
def _():
    link = LossyLink(LinkConfig(dup_rate=0.2, reorder_rate=0.2, latency_ms=100, jitter_ms=20, seed=3))
    outs = [link.transmit(b"x", 0) for _ in range(500)]
    assert any(len(o) == 2 for o in outs)
    delays = [t for o in outs for t, _ in o]
    assert min(delays) >= 80 and max(delays) <= 100 + 20 + 300
    assert any(t > 150 for t in delays)                 # reorder delay applied


@check("link+receiver: every corrupted packet is caught by the CRC")
def _():
    link = LossyLink(LinkConfig(corrupt_rate=0.5, seed=5))
    rx = Receiver()
    s = Sender(lambda d, t: [rx.on_packet(p, tt) for tt, p in link.transmit(d, t)])
    for i in range(400):
        s.send([det(x=i)], i * 100)
    assert link.stats["corrupted"] > 100
    assert rx.stats["crc_fail"] == link.stats["corrupted"], (rx.stats["crc_fail"], link.stats["corrupted"])
    return f"{rx.stats['crc_fail']} corrupted, {rx.stats['crc_fail']} rejected"


# ============================ 3. RECEIVER ====================================
def _frames(n, start=0):
    return {start + i: encode_frame((start + i) & 0xFFFF, [det(x=i)]) for i in range(n)}


@check("receiver: duplicate frames are processed once and counted")
def _():
    got = []
    rx = Receiver(on_frame=got.append)
    p = encode_frame(1, [det()])
    rx.on_packet(p, 10)
    rx.on_packet(p, 20)
    assert len(got) == 1 and rx.stats["duplicates"] == 1 and rx.stats["unique"] == 1


@check("receiver: 16-bit sequence wrap (65530 -> 13) counts 20 frames, 0 lost")
def _():
    rx = Receiver()
    s = Sender(lambda d, t: rx.on_packet(d, t), start_seq=65530)
    for i in range(20):
        s.send([det(x=i)], i * 100)
    assert (rx.expected, rx.stats["unique"], rx.lost) == (20, 20, 0), (rx.expected, rx.stats["unique"], rx.lost)


@check("receiver: reordered frames accepted, loss counted correctly")
def _():
    fr = _frames(10)
    rx = Receiver()
    feed(rx, fr, [0, 1, 2, 5, 3, 4, 6, 7, 9, 8])
    assert rx.stats["unique"] == 10 and rx.stats["reordered"] >= 2 and rx.lost == 0
    rx2 = Receiver()
    feed(rx2, fr, [0, 1, 2, 3, 7, 8, 9])                # 4,5,6 never arrive
    assert rx2.lost == 3 and abs(rx2.loss_fraction() - 0.3) < 1e-9


@check("receiver: garbage datagrams never crash it")
def _():
    rx = Receiver()
    rng = random.Random(1)
    for _ in range(2000):
        rx.on_packet(bytes(rng.randrange(256) for _ in range(rng.randrange(0, 300))), 0)
    assert rx.stats["unique"] == 0 and rx.stats["crc_fail"] == 2000


@check("receiver: dedup memory is bounded")
def _():
    rx = Receiver(window=50)
    for i in range(500):
        rx.on_packet(encode_frame(i, [det(x=i)]), i)
    assert len(rx._seen) <= 50 and len(rx._order) <= 50


@check("hazard map: latest observation wins, memory is bounded")
def _():
    mm = MissionMap(max_cells=20)
    mk = lambda ts, rx_ms: {"rx_ms": rx_ms, "detections": [
        {"class": "boulder", "x_cm": 150, "y_cm": 250, "ts_ms": ts, "conf": 5, "sigma_cm": 10}]}
    assert mm.update(mk(1000, 2300)) == 1
    assert mm.update(mk(500, 2400)) == 0                # stale repeat must not overwrite
    assert mm.update(mk(3000, 4300)) == 0
    c = next(iter(mm.cells.values()))
    assert c["ts_ms"] == 3000 and c["first_rx_ms"] == 2300
    for i in range(100):
        mm.update({"rx_ms": i, "detections": [{"class": "ice", "x_cm": i * 100, "y_cm": 0,
                                               "ts_ms": i, "conf": 1, "sigma_cm": 5}]})
    assert len(mm.cells) <= 20


# ============================ 4. RESILIENCE ==================================
@check("resilience: resilient >= naive coverage at every loss level, big gain at 30%/50%")
def _():
    from telemetry import compare
    rows = []
    for loss in (0.0, 0.1, 0.3, 0.5):
        n = compare.aggregate("naive", loss, range(10))
        r = compare.aggregate("resilient", loss, range(10))
        assert r["coverage"] >= n["coverage"] - 1e-9, (loss, n, r)
        rows.append((loss, n["coverage"], r["coverage"]))
    d = {l: (n, r) for l, n, r in rows}
    assert d[0.0][1] > 0.95 and d[0.3][1] > 0.9 and d[0.5][1] > d[0.5][0] + 0.15, d
    return "; ".join(f"{l:.0%}: {n:.0%}->{r:.0%}" for l, n, r in rows)


@check("resilience: every frame <= 234 B and the repeat budget holds")
def _():
    sizes = []
    rs = ResilientSender(lambda d, t: sizes.append(len(d)))
    from telemetry.fake_rover import FakeRover
    rover = FakeRover(seed=2)
    for t in range(0, 120_001, 500):
        rs.observe(rover.step(t), t)
        rs.tick(t)
    assert max(sizes) <= 234
    rate = sum(sizes) / 120
    assert rate < 150, rate
    return f"max frame {max(sizes)} B, average {rate:.0f} B/s"


@check("resilience: bounded memory (entries capped) and no crash on 5000 hazards")
def _():
    rs = ResilientSender(lambda d, t: None)
    rs.cfg.max_entries = 100
    for i in range(5000):
        rs.observe([det(x=i * 100, y=0, ts=i)], i)
        rs.tick(i * 500)
    assert len(rs.entries) <= 100


@check("end to end: same seed -> byte-identical results (jury can reproduce)")
def _():
    from telemetry import compare
    assert compare.run_one("resilient", 0.3, 4) == compare.run_one("resilient", 0.3, 4)


@check("end to end: blackout recovery - map is complete shortly after the link returns")
def _():
    from telemetry import compare
    hazards = compare.make_hazards(1)
    link = LossyLink(LinkConfig.with_avg_loss(0.1, bursty=True, blackouts=[(20_000, 30_000)],
                                              latency_ms=1300, jitter_ms=100, seed=1))
    mm = MissionMap()
    ch = SimChannel(link, Receiver(on_frame=mm.update))
    rs = ResilientSender(ch.send)
    by_t = {h.ts_ms: h for h in hazards}
    for t in range(0, 61_000, 500):
        if t in by_t:
            rs.observe([by_t[t]], t)
        rs.tick(t)
        ch.advance(t)
    ch.advance(90_000)
    during = [h for h in hazards if 20_000 <= h.ts_ms < 30_000]
    known = [mm.cells.get(compare.det_key(h)) for h in during]
    assert during and all(known), "hazards seen during the blackout never arrived"
    first_after = min(c["first_rx_ms"] for c in known)
    assert first_after >= 30_000
    return f"first blackout-era hazard delivered {(first_after - 30_000) / 1000:.1f} s after the link returned"


# ============================ 5. REAL UDP ====================================
@check("udp: real loopback sockets deliver frames through the transport")
def _():
    from telemetry.udp import MissionClock, open_udp_transport, start_receiver

    async def go():
        clock = MissionClock()
        rx = Receiver()
        srv = await start_receiver(rx, "127.0.0.1", 9187, clock.now_ms)
        tx = await open_udp_transport(LossyLink(LinkConfig(seed=1)), "127.0.0.1", 9187)
        s = Sender(tx.send)
        for i in range(10):
            s.send([det(x=i)], clock.now_ms())
        await asyncio.sleep(0.3)
        srv.close()
        tx.transport.close()
        return rx

    rx = asyncio.run(go())
    assert rx.stats["unique"] == 10, rx.stats
    return "10/10 frames over 127.0.0.1"


# ============================ 6. PERCEPTION ADAPTER ==========================
@check("adapter: tracking removes duplicate hazards, rotation and beacons correct")
def _():
    sys.path.insert(0, os.getcwd())
    try:
        from tests import test_perception_adapter as t
    except ImportError:
        raise SkipCheck("tests/test_perception_adapter.py not found")
    t.test_tracking_removes_duplicates_and_keeps_coverage()
    t.test_rover_to_world_rotation()
    t.test_beacon_cadence()


# ============================ 7. LIVE WEBSOCKET BRIDGE =======================
@check("bridge: WebSocket snapshots, hazards arrive, kill-link button works")
def _():
    try:
        import websockets
        from telemetry import bridge
    except ImportError:
        raise SkipCheck("websockets not installed (pip install websockets)")

    import json

    async def go():
        srv = asyncio.create_task(bridge.run(ws_port=8791, udp_port=9188, loss=0.0, latency_ms=50,
                                             jitter_ms=0, snapshot_period_s=0.3, duration_s=9))
        await asyncio.sleep(0.5)
        async with websockets.connect("ws://127.0.0.1:8791") as ws:
            async def next_snap(timeout=3):
                while True:
                    m = json.loads(await asyncio.wait_for(ws.recv(), timeout))
                    if m.get("type") == "snapshot":
                        return m
            first = await next_snap()
            assert {"t_ms", "hazards", "link"} <= set(first)
            await asyncio.sleep(3)
            snap = await next_snap()
            real = [h for h in snap["hazards"] if h["class"] != "beacon"]
            assert snap["hazards"] and snap["link"]["received"] > 0, snap["link"]
            await ws.send(json.dumps({"type": "set_blackout", "on": True}))
            for _ in range(10):
                snap = await next_snap()
                if snap["link"]["blackout"]:
                    break
            else:
                raise AssertionError("blackout flag never turned on")
            await ws.send(json.dumps({"type": "set_blackout", "on": False}))
            for _ in range(10):
                if not (await next_snap())["link"]["blackout"]:
                    break
            else:
                raise AssertionError("blackout flag never turned off")
        await srv
        return len(real)

    n = asyncio.run(go())
    return f"{n} hazards visible, blackout toggled on/off"


# ============================ REPORT =========================================
def main():
    lines = []
    width = max(len(n) for n, *_ in RESULTS)
    for name, ok, note, dt in RESULTS:
        tag = {True: "PASS", False: "FAIL", None: "SKIP"}[ok]
        lines.append(f"[{tag}] {name.ljust(width)}  ({dt:4.1f}s)  {note.splitlines()[0] if note and ok is not False else ''}")
        if ok is False:
            lines.extend("        " + l for l in note.splitlines())
    p = sum(1 for r in RESULTS if r[1] is True)
    f = sum(1 for r in RESULTS if r[1] is False)
    s = sum(1 for r in RESULTS if r[1] is None)
    lines.append(f"\n{p} passed, {f} failed, {s} skipped")
    out = "\n".join(lines)
    print(out)
    os.makedirs("results", exist_ok=True)
    with open("results/final_check.txt", "w") as fh:
        fh.write(out + "\n")
    sys.exit(1 if f else 0)


if __name__ == "__main__":
    main()