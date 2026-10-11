import argparse
import asyncio
import json
import math
import random
import time

from websockets.asyncio.server import ServerConnection, serve


SNAPSHOT_INTERVAL_SECONDS = 1
AUTO_BLACKOUT_SECONDS = 10
BLACKOUT_PERIOD_SECONDS = 60
HAZARD_SPECS = (
    ("crater:3:-2", "crater", 300, -200, 0),
    ("rock:5:1", "rock", 500, 100, 0),
    ("ice:-4:6", "ice", -400, 600, 8_000),
    ("unknown:2:7", "unknown", 200, 700, 16_000),
    ("crater:-8:4", "crater", -800, 400, 24_000),
    ("rock:-6:-5", "rock", -600, -500, 32_000),
    ("ice:9:-3", "ice", 900, -300, 40_000),
    ("unknown:-2:-9", "unknown", -200, -900, 48_000),
    ("crater:11:5", "crater", 1_100, 500, 56_000),
    ("rock:-10:8", "rock", -1_000, 800, 64_000),
)


class SnapshotMock:
    def __init__(self) -> None:
        self.started_at = time.monotonic()
        self.random = random.Random()
        self.clients: set[ServerConnection] = set()
        self.forced_blackout: bool | None = None
        self.created_hazards: dict[str, dict] = {}
        self.last_beacon_ms = 0
        self.expected = 0
        self.received = 0
        self.lost = 0
        self.crc_fail = 0
        self.duplicates = 0
        self.reordered = 0
        self.bytes_rx = 0
        self.last_rx_ms = 0

    def mission_time_ms(self) -> int:
        return int((time.monotonic() - self.started_at) * 1000)

    def blackout(self, mission_time_ms: int) -> bool:
        if self.forced_blackout is not None:
            return self.forced_blackout
        period_ms = BLACKOUT_PERIOD_SECONDS * 1000
        return mission_time_ms % period_ms < AUTO_BLACKOUT_SECONDS * 1000

    def make_hazards(self, mission_time_ms: int) -> list[dict]:
        hazards = []
        for hazard_id, class_name, x_cm, y_cm, _appears_at_ms in HAZARD_SPECS:
            detection = self.created_hazards.get(hazard_id)
            if detection is None:
                continue
            created_at_ms = detection["created_at_ms"]
            age_ms = max(0, mission_time_ms - created_at_ms)
            hazards.append(
                {
                    "id": hazard_id,
                    "class": class_name,
                    "conf": detection["conf"],
                    "x_cm": x_cm,
                    "y_cm": y_cm,
                    "sigma_cm": detection["sigma_cm"],
                    "ts_ms": created_at_ms,
                    "age_ms": age_ms,
                    "since_rx_ms": age_ms,
                    "first_rx_ms": created_at_ms,
                }
            )

        hazards.append(
            {
                "id": "rover:beacon",
                "class": "beacon",
                "conf": 7,
                "x_cm": round(self.rover_position(self.last_beacon_ms)[0], 1),
                "y_cm": round(self.rover_position(self.last_beacon_ms)[1], 1),
                "ts_ms": self.last_beacon_ms,
                "age_ms": max(0, mission_time_ms - self.last_beacon_ms),
                "since_rx_ms": max(0, mission_time_ms - self.last_beacon_ms),
                "first_rx_ms": self.last_beacon_ms,
            }
        )
        return hazards

    def add_detections(self, mission_time_ms: int) -> None:
        rover_x, rover_y = self.rover_position(mission_time_ms)
        for hazard_id, class_name, x_cm, y_cm, appears_at_ms in HAZARD_SPECS:
            if (
                mission_time_ms < appears_at_ms
                or hazard_id in self.created_hazards
            ):
                continue
            distance_cm = math.hypot(x_cm - rover_x, y_cm - rover_y)
            self.created_hazards[hazard_id] = {
                "created_at_ms": mission_time_ms,
                "sigma_cm": round(8 + distance_cm * 0.035, 1),
                "conf": self.random.randint(0, 7),
            }
        self.last_beacon_ms = mission_time_ms

    @staticmethod
    def rover_position(mission_time_ms: int) -> tuple[float, float]:
        elapsed_seconds = mission_time_ms / 1000
        phase = elapsed_seconds / 24
        return 700 * math.cos(phase), 500 * math.sin(phase)

    def make_snapshot(self, mission_time_ms: int) -> dict:
        blackout = self.blackout(mission_time_ms)
        transient_outage = mission_time_ms % 30_000 < 4_000
        self.expected += 1
        packet_received = (
            not blackout
            and not transient_outage
            and self.random.random() >= 0.12
        )
        if packet_received:
            self.received += 1
            self.last_rx_ms = mission_time_ms
            self.add_detections(mission_time_ms)
            self.bytes_rx += 384 + len(self.created_hazards) * 112
            if self.random.random() < 0.025:
                self.crc_fail += 1
            if self.random.random() < 0.02:
                self.duplicates += 1
            if self.random.random() < 0.035:
                self.reordered += 1
        else:
            self.lost += 1

        loss_pct = self.lost / self.expected * 100 if self.expected else 0
        return {
            "type": "snapshot",
            "t_ms": mission_time_ms,
            "hazards": self.make_hazards(mission_time_ms),
            "link": {
                "expected": self.expected,
                "received": self.received,
                "lost": self.lost,
                "loss_pct": round(loss_pct, 2),
                "crc_fail": self.crc_fail,
                "duplicates": self.duplicates,
                "reordered": self.reordered,
                "bytes_rx": self.bytes_rx,
                "last_rx_ms": self.last_rx_ms,
                "since_last_rx_ms": max(0, mission_time_ms - self.last_rx_ms),
                "blackout": blackout,
            },
        }

    async def broadcast_snapshots(self) -> None:
        while True:
            await asyncio.sleep(SNAPSHOT_INTERVAL_SECONDS)
            mission_time_ms = self.mission_time_ms()
            message = json.dumps(self.make_snapshot(mission_time_ms))
            clients = tuple(self.clients)
            if not clients:
                continue
            results = await asyncio.gather(
                *(client.send(message) for client in clients),
                return_exceptions=True,
            )
            for client, result in zip(clients, results):
                if isinstance(result, Exception):
                    self.clients.discard(client)

    async def handle_client(self, websocket: ServerConnection) -> None:
        self.clients.add(websocket)
        try:
            async for raw_message in websocket:
                try:
                    message = json.loads(raw_message)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue
                if (
                    isinstance(message, dict)
                    and message.get("type") == "set_blackout"
                    and isinstance(message.get("on"), bool)
                ):
                    self.forced_blackout = message["on"]
        finally:
            self.clients.discard(websocket)


async def main(host: str, port: int) -> None:
    mock = SnapshotMock()
    broadcaster = asyncio.create_task(mock.broadcast_snapshots())
    try:
        async with serve(mock.handle_client, host, port):
            print(f"Snapshot mock listening at ws://{host}:{port}")
            print("Press Ctrl+C to stop.")
            await asyncio.Future()
    finally:
        broadcaster.cancel()
        await asyncio.gather(broadcaster, return_exceptions=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="C.R.A.T.E.R. snapshot mock server")
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=8765)
    arguments = parser.parse_args()
    try:
        asyncio.run(main(arguments.host, arguments.port))
    except KeyboardInterrupt:
        pass
