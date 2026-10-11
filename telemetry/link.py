"""Lossy link emulator (deterministic, simulated clock).

transmit(data, now_ms) -> list of (deliver_at_ms, bytes)
  []              -> packet lost
  [(t, data)]     -> delivered at time t
  [(t1,..),(t2,..)] -> duplicated
Models: uniform loss, Gilbert-Elliott burst loss, scheduled/manual blackouts,
latency + jitter, reordering, duplication, bit corruption.
"""
import random
from dataclasses import dataclass, field
from typing import List, Tuple


@dataclass
class LinkConfig:
    loss_rate: float = 0.0          # uniform random loss probability
    burst_p_gb: float = 0.0         # P(good -> bad) per packet; 0 disables burst model
    burst_p_bg: float = 0.3         # P(bad -> good) per packet; mean burst = 1/p_bg packets
    blackouts: List[Tuple[int, int]] = field(default_factory=list)  # [start_ms, end_ms)
    latency_ms: int = 0
    jitter_ms: int = 0              # +/- uniform jitter
    dup_rate: float = 0.0
    reorder_rate: float = 0.0       # chance a packet gets extra delay
    reorder_extra_ms: int = 300
    corrupt_rate: float = 0.0       # chance of one flipped bit
    seed: int = 42

    @classmethod
    def with_avg_loss(cls, avg_loss: float, bursty: bool = False, **kw) -> "LinkConfig":
        """Config whose long-run loss rate is avg_loss (uniform or bursty)."""
        if not bursty or avg_loss <= 0:
            return cls(loss_rate=avg_loss, **kw)
        p_bg = kw.pop("burst_p_bg", 0.3)
        p_gb = avg_loss * p_bg / (1.0 - avg_loss)  # steady-state bad fraction = avg_loss
        return cls(burst_p_gb=p_gb, burst_p_bg=p_bg, **kw)


class LossyLink:
    def __init__(self, cfg: LinkConfig):
        self.cfg = cfg
        self.rng = random.Random(cfg.seed)
        self.bad_state = False
        self.forced_blackout = False   # toggled by the demo "kill link" button
        self.stats = {
            "sent": 0, "dropped_blackout": 0, "dropped_burst": 0,
            "dropped_random": 0, "duplicated": 0, "corrupted": 0, "delivered": 0,
        }

    def set_blackout(self, on: bool) -> None:
        self.forced_blackout = on

    def in_blackout(self, now_ms: int) -> bool:
        if self.forced_blackout:
            return True
        return any(s <= now_ms < e for s, e in self.cfg.blackouts)

    def transmit(self, data: bytes, now_ms: int) -> List[Tuple[int, bytes]]:
        c, r = self.cfg, self.rng
        self.stats["sent"] += 1

        if self.in_blackout(now_ms):
            self.stats["dropped_blackout"] += 1
            return []

        if c.burst_p_gb > 0:
            if self.bad_state:
                if r.random() < c.burst_p_bg:
                    self.bad_state = False
            elif r.random() < c.burst_p_gb:
                self.bad_state = True
            if self.bad_state:
                self.stats["dropped_burst"] += 1
                return []

        if c.loss_rate > 0 and r.random() < c.loss_rate:
            self.stats["dropped_random"] += 1
            return []

        copies = 1
        if c.dup_rate > 0 and r.random() < c.dup_rate:
            copies = 2
            self.stats["duplicated"] += 1

        out = []
        for _ in range(copies):
            delay = c.latency_ms
            if c.jitter_ms:
                delay += r.randint(-c.jitter_ms, c.jitter_ms)
            if c.reorder_rate > 0 and r.random() < c.reorder_rate:
                delay += c.reorder_extra_ms
            payload = data
            if c.corrupt_rate > 0 and r.random() < c.corrupt_rate:
                b = bytearray(data)
                if b:
                    b[r.randrange(len(b))] ^= 1 << r.randrange(8)
                payload = bytes(b)
                self.stats["corrupted"] += 1
            out.append((now_ms + max(0, delay), payload))
            self.stats["delivered"] += 1
        out.sort(key=lambda t: t[0])
        return out

    def loss_fraction(self) -> float:
        s = self.stats["sent"]
        lost = s - self.stats["delivered"] + self.stats["duplicated"]
        return lost / s if s else 0.0