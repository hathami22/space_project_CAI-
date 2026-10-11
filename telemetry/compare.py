"""Naive vs resilient under identical link statistics, averaged over seeds.
Run: python -m telemetry.compare"""
import json
import os
import random

from .channel import SimChannel
from .codec import Detection
from .hazardmap import MissionMap, det_key
from .link import LinkConfig, LossyLink
from .receiver import Receiver
from .resilient import ResilientSender
from .sender import Sender

DURATION_MS = 90_000
STEP_MS = 500
DISCOVER_EVERY_MS = 1500
LAST_DISCOVERY_MS = 75_000
BLACKOUTS = [(20_000, 30_000), (55_000, 62_000)]


def make_hazards(seed):
    rng = random.Random(seed)
    out, seen = [], set()
    for t in range(0, LAST_DISCOVERY_MS + 1, DISCOVER_EVERY_MS):
        while True:
            d = Detection(rng.choice([0, 0, 1, 2]), rng.randrange(3, 8),
                          rng.randint(-3000, 3000), rng.randint(-3000, 3000),
                          t, rng.uniform(10, 300))
            if det_key(d) not in seen:
                seen.add(det_key(d))
                break
        out.append(d)
    return out


def run_one(strategy, avg_loss, seed):
    hazards = make_hazards(seed)
    by_t = {h.ts_ms: h for h in hazards}
    link = LossyLink(LinkConfig.with_avg_loss(
        avg_loss, bursty=True, blackouts=list(BLACKOUTS),
        latency_ms=1300, jitter_ms=100, seed=seed))
    mm = MissionMap()
    chan = SimChannel(link, Receiver(on_frame=mm.update))
    naive = resil = None
    if strategy == "naive":
        naive = Sender(chan.send)
    else:
        resil = ResilientSender(chan.send)

    for t in range(0, DURATION_MS + 1, STEP_MS):
        h = by_t.get(t)
        if naive:
            if h:
                naive.send([h], t)              # send once, one frame per detection
        else:
            if h:
                resil.observe([h], t)
            resil.tick(t)
        chan.advance(t)
    chan.advance(DURATION_MS + 30_000)          # flush in-flight packets

    tx_stats = naive.stats if naive else resil.tx_stats
    lat = []
    for h in hazards:
        c = mm.cells.get(det_key(h))
        if c:
            lat.append(c["first_rx_ms"] - h.ts_ms)
    return {"coverage": len(lat) / len(hazards), "lat": lat, "bytes": tx_stats["bytes"]}


def aggregate(strategy, loss, seeds):
    runs = [run_one(strategy, loss, s) for s in seeds]
    lats = sorted(x for r in runs for x in r["lat"])
    n = len(runs)
    return {
        "coverage": sum(r["coverage"] for r in runs) / n,
        "lat_mean_ms": sum(lats) / len(lats) if lats else None,
        "lat_p95_ms": lats[int(0.95 * (len(lats) - 1))] if lats else None,
        "bytes_per_s": sum(r["bytes"] for r in runs) / n / (DURATION_MS / 1000),
    }


def main(seeds=30):
    print("Hazards known to Mission Control at end of run (2 blackouts = 17 s of 90 s)")
    print("loss | coverage naive -> resilient | mean latency s | p95 latency s | bytes/s")
    rows = []
    for loss in (0.0, 0.1, 0.3, 0.5):
        n = aggregate("naive", loss, range(seeds))
        r = aggregate("resilient", loss, range(seeds))
        rows.append({"loss": loss, "naive": n, "resilient": r})
        f = lambda v: "  -  " if v is None else f"{v / 1000:5.1f}"
        print(f"{loss:4.0%} | {n['coverage']:6.1%} -> {r['coverage']:6.1%}       | "
              f"{f(n['lat_mean_ms'])} -> {f(r['lat_mean_ms'])} | "
              f"{f(n['lat_p95_ms'])} -> {f(r['lat_p95_ms'])} | "
              f"{n['bytes_per_s']:5.1f} -> {r['bytes_per_s']:5.1f}")
    os.makedirs("results", exist_ok=True)
    with open("results/resilience.json", "w") as fh:
        json.dump({"seeds": seeds, "rows": rows}, fh, indent=2)
    print("saved results/resilience.json")


if __name__ == "__main__":
    main()