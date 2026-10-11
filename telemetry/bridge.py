"""Live bridge: rover -> resilient sender -> lossy UDP -> receiver -> WebSocket.

Run:  python -m telemetry.bridge --loss 0.1 --blackout 20:30
WebSocket contract (ws://localhost:8765):
  server -> client  {"type":"snapshot","t_ms":..,"hazards":[..],"link":{..}}  ~1/s
  client -> server  {"type":"set_blackout","on":true|false}
"""
import argparse
import asyncio
import json

import websockets

from .fake_rover import FakeRover
from .hazardmap import MissionMap
from .link import LinkConfig, LossyLink
from .receiver import Receiver
from .resilient import ResilientConfig, ResilientSender
from .udp import MissionClock, open_udp_transport, start_receiver


def build_snapshot(mm, rx, link, now_ms):
    hazards = [{"id": f"{c['class']}:{c['x_cm'] // 100}:{c['y_cm'] // 100}", **c}
               for c in mm.snapshot(now_ms)]
    status = rx.link_status(now_ms)
    status["blackout"] = link.in_blackout(now_ms)
    return {"type": "snapshot", "t_ms": now_ms, "hazards": hazards, "link": status}


async def run(ws_port=8765, udp_port=9000, loss=0.1, blackouts=(), latency_ms=1300,
              jitter_ms=100, seed=1, step_ms=500, snapshot_period_s=1.0,
              duration_s=None, rover=None, verbose=False):
    clock = MissionClock()
    rover = rover or FakeRover(seed=seed)
    link = LossyLink(LinkConfig.with_avg_loss(
        loss, bursty=True,
        blackouts=[(int(a * 1000), int(b * 1000)) for a, b in blackouts],
        latency_ms=latency_ms, jitter_ms=jitter_ms, seed=seed))
    mm = MissionMap()
    rx = Receiver(on_frame=mm.update)
    udp_rx = await start_receiver(rx, "127.0.0.1", udp_port, clock.now_ms)
    tx_t = await open_udp_transport(link, "127.0.0.1", udp_port)
    rs = ResilientSender(tx_t.send, ResilientConfig(max_entries=1024))
    clients = set()

    async def handler(ws):
        clients.add(ws)
        try:
            await ws.send(json.dumps(build_snapshot(mm, rx, link, clock.now_ms())))
            async for msg in ws:
                try:
                    m = json.loads(msg)
                except ValueError:
                    continue
                if isinstance(m, dict) and m.get("type") == "set_blackout":
                    link.set_blackout(bool(m.get("on")))
        finally:
            clients.discard(ws)

    async def rover_loop():
        while True:
            t = clock.now_ms()
            rs.observe(rover.step(t), t)
            rs.tick(t)
            await asyncio.sleep(step_ms / 1000)

    async def broadcast_loop():
        while True:
            await asyncio.sleep(snapshot_period_s)
            if clients:
                websockets.broadcast(clients, json.dumps(
                    build_snapshot(mm, rx, link, clock.now_ms())))

    async def status_loop():
        while True:
            await asyncio.sleep(5)
            t = clock.now_ms()
            s = rx.link_status(t)
            print(f"[{t / 1000:6.1f}s] hazards known={len(mm.cells):3d}  "
                  f"frames rx={s['received']}/{s['expected']} (loss {s['loss_pct']}%)  "
                  f"tx={rs.tx_stats['bytes']} B  blackout={link.in_blackout(t)}", flush=True)

    async with websockets.serve(handler, "127.0.0.1", ws_port):
        tasks = [asyncio.create_task(f()) for f in (rover_loop, broadcast_loop)]
        if verbose:
            tasks.append(asyncio.create_task(status_loop()))
        try:
            if duration_s:
                await asyncio.sleep(duration_s)
            else:
                await asyncio.Future()
        finally:
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            udp_rx.close()
            tx_t.transport.close()


def main():
    ap = argparse.ArgumentParser(description="Live telemetry bridge")
    ap.add_argument("--loss", type=float, default=0.1, help="average link loss 0..1")
    ap.add_argument("--blackout", action="append", default=[],
                    help="START:END in mission seconds (repeatable), e.g. 20:30")
    ap.add_argument("--latency-ms", type=int, default=1300)
    ap.add_argument("--jitter-ms", type=int, default=100)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--ws-port", type=int, default=8765)
    ap.add_argument("--udp-port", type=int, default=9000)
    ap.add_argument("--duration-s", type=float, default=None)
    a = ap.parse_args()
    blackouts = [tuple(float(x) for x in b.split(":")) for b in a.blackout]
    print(f"Bridge up: ws://localhost:{a.ws_port}  loss={a.loss:.0%}  blackouts={blackouts}")
    try:
        asyncio.run(run(ws_port=a.ws_port, udp_port=a.udp_port, loss=a.loss,
                        blackouts=blackouts, latency_ms=a.latency_ms, jitter_ms=a.jitter_ms,
                        seed=a.seed, duration_s=a.duration_s, verbose=True))
    except KeyboardInterrupt:
        print("stopped")


if __name__ == "__main__":
    main()
    