"""Quick simulation: python -m telemetry.sim_demo"""
import json
import random
from .channel import SimChannel
from .codec import Detection, CLASS_NAMES
from .link import LinkConfig, LossyLink
from .receiver import Receiver
from .sender import Sender


def make_dets(rng, t, n):
    return [Detection(rng.randrange(0, 3), rng.randrange(3, 8),
                      rng.randint(-3000, 3000), rng.randint(-3000, 3000),
                      t, rng.uniform(10, 300)) for _ in range(n)]


def naive_json_size(dets, seq):
    """What a typical team would send: one JSON object per detection."""
    return sum(len(json.dumps({
        "seq": seq, "timestamp": d.ts_ms, "class": CLASS_NAMES[d.class_id],
        "confidence": round(d.conf / 7, 2), "x": d.x_cm / 100, "y": d.y_cm / 100,
        "uncertainty_m": round(d.sigma_cm / 100, 2)}).encode()) for d in dets)


def run(avg_loss, bursty=True, blackouts=((20_000, 30_000),), duration_ms=60_000,
        period_ms=500, per_frame=2, seed=1):
    rng = random.Random(seed)
    link = LossyLink(LinkConfig.with_avg_loss(
        avg_loss, bursty=bursty, blackouts=list(blackouts),
        latency_ms=1300, jitter_ms=100, seed=seed))      # ~Earth-Moon one-way delay
    ages = []
    rx = Receiver(on_frame=lambda f: ages.append(f["rx_ms"] - f["detections"][0]["ts_ms"]))
    chan = SimChannel(link, rx)
    tx = Sender(chan.send)
    json_bytes = 0
    t = 0
    while t < duration_ms:
        dets = make_dets(rng, t, per_frame)
        json_bytes += naive_json_size(dets, tx.seq)
        tx.send(dets, t)
        chan.advance(t)
        t += period_ms
    chan.advance(duration_ms + 60_000)                   # flush in-flight packets
    return {
        "loss": avg_loss, "sent": tx.stats["frames"], "delivered": rx.stats["unique"],
        "bin_bytes": tx.stats["bytes"], "json_bytes": json_bytes,
        "rx_loss_est": rx.loss_fraction(), "true_loss": link.loss_fraction(),
        "mean_age_ms": sum(ages) / len(ages) if ages else 0,
    }


def main():
    print("loss | sent | delivered | binary B | JSON B | ratio | est loss | true loss | mean age")
    for loss in (0.0, 0.1, 0.3, 0.5):
        r = run(loss)
        print(f"{loss:4.0%} | {r['sent']:4d} | {r['delivered']/r['sent']:8.0%} | "
              f"{r['bin_bytes']:8d} | {r['json_bytes']:6d} | {r['json_bytes']/r['bin_bytes']:4.1f}x | "
              f"{r['rx_loss_est']:7.1%} | {r['true_loss']:8.1%} | {r['mean_age_ms']:6.0f} ms")
    print("(includes a 10 s blackout at t=20-30 s; 1.3 s latency)")


if __name__ == "__main__":
    main()
    