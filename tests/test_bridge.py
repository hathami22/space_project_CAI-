import asyncio
import json

import pytest

websockets = pytest.importorskip("websockets")

from telemetry.bridge import build_snapshot, run
from telemetry.hazardmap import MissionMap
from telemetry.link import LinkConfig, LossyLink
from telemetry.receiver import Receiver


def test_build_snapshot_shape():
    mm = MissionMap()
    rx = Receiver(on_frame=mm.update)
    link = LossyLink(LinkConfig())
    mm.update({"detections": [{"class": "crater", "conf": 6, "x_cm": 350, "y_cm": -120,
                               "ts_ms": 1000, "sigma_cm": 14.8}], "rx_ms": 2000})
    s = build_snapshot(mm, rx, link, 5000)
    h = s["hazards"][0]
    assert s["type"] == "snapshot" and s["t_ms"] == 5000
    assert h["id"] == "crater:3:-2" and h["age_ms"] == 4000 and h["since_rx_ms"] == 3000
    assert s["link"]["blackout"] is False and "loss_pct" in s["link"]


def test_live_bridge_streams_and_obeys_kill_switch():
    async def main():
        task = asyncio.create_task(run(ws_port=8799, udp_port=9099, loss=0.0, latency_ms=50,
                                       jitter_ms=0, snapshot_period_s=0.2, duration_s=5))
        await asyncio.sleep(0.6)
        async with websockets.connect("ws://127.0.0.1:8799") as ws:
            first = json.loads(await asyncio.wait_for(ws.recv(), 3))
            assert first["type"] == "snapshot" and first["link"]["blackout"] is False
            await ws.send(json.dumps({"type": "set_blackout", "on": True}))
            saw = False
            for _ in range(10):
                s = json.loads(await asyncio.wait_for(ws.recv(), 3))
                if s["link"]["blackout"]:
                    saw = True
                    break
            assert saw
        await task
    asyncio.run(main())