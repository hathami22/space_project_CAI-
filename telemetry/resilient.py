"""Rover-side resilience: repeats, refresh, coalescing, byte budget. No ACKs needed."""
from dataclasses import dataclass, field
from typing import Dict, List
from .codec import (Detection, HEADER_SIZE, CRC_SIZE, DET_SIZE, FLAG_CRITICAL,
                    FLAG_RETRANSMIT, CLASS_BOULDER, CLASS_CRATER, CLASS_ICE, CLASS_BEACON)
from .hazardmap import det_key
from .sender import Sender

SPAN_LIMIT_MS = 25_000           # a frame's 1-byte dt field covers 25.5 s
PRIORITY = {CLASS_CRATER: 2, CLASS_ICE: 2, CLASS_BOULDER: 1}   # beacon = 0


@dataclass
class ResilientConfig:
    repeats: Dict[int, int] = field(default_factory=lambda: {0: 2, 1: 3, 2: 3, 3: 1})
    repeat_gap_ms: int = 1500
    refresh_period_ms: int = 10_000
    budget_bps: float = 40.0     # bytes per second for repeats + refresh
    max_det_per_tick: int = 8
    max_entries: int = 256       # bounded memory


@dataclass
class _Entry:
    det: Detection
    sends: int = 0
    last_sent_ms: int = -10**9


class ResilientSender:
    def __init__(self, send_fn, cfg: ResilientConfig = None):
        self.cfg = cfg or ResilientConfig()
        self.sender = Sender(send_fn)
        self.entries: Dict[tuple, _Entry] = {}
        self._allow = self.cfg.budget_bps * 2
        self._last_tick = None
        self.stats = {"new": 0, "repeat": 0, "refresh": 0, "frames": 0}

    @property
    def tx_stats(self):
        return self.sender.stats

    def observe(self, dets: List[Detection], now_ms: int) -> None:
        """Feed every detection from perception. Same cell => coalesced (latest wins)."""
        for d in dets:
            k = det_key(d)
            e = self.entries.get(k)
            if e is None:
                self.entries[k] = _Entry(det=d)
            elif d.ts_ms >= e.det.ts_ms:
                e.det = d
        while len(self.entries) > self.cfg.max_entries:
            # evict lowest priority first (beacons), then oldest
            victim = min(self.entries, key=lambda k: (
                PRIORITY.get(self.entries[k].det.class_id, 0), self.entries[k].det.ts_ms))
            del self.entries[victim]

    def _due(self, now_ms: int):
        cfg, out = self.cfg, []
        for e in self.entries.values():
            want = cfg.repeats.get(e.det.class_id, 1)
            if e.sends == 0:
                tier = 0                                              # new hazard
            elif e.sends < want and now_ms - e.last_sent_ms >= cfg.repeat_gap_ms:
                tier = 1                                              # spaced repeat
            elif (e.det.class_id != CLASS_BEACON
                  and now_ms - e.last_sent_ms >= cfg.refresh_period_ms):
                tier = 2                                              # background refresh
            else:
                continue
            out.append((tier, -PRIORITY.get(e.det.class_id, 0), e.last_sent_ms, e))
        out.sort(key=lambda t: t[:3])
        return [(t[0], t[3]) for t in out]

    def tick(self, now_ms: int) -> int:
        """Call periodically (e.g. every 500 ms). Returns frames sent."""
        cfg = self.cfg
        dt = 0 if self._last_tick is None else max(0, now_ms - self._last_tick)
        self._last_tick = now_ms
        self._allow = min(self._allow + cfg.budget_bps * dt / 1000, cfg.budget_bps * 2)

        chosen, spend = [], 0.0
        for tier, e in self._due(now_ms):
            if len(chosen) >= cfg.max_det_per_tick:
                break
            cost = DET_SIZE + (0 if chosen else HEADER_SIZE + CRC_SIZE)
            if tier > 0 and self._allow - spend < cost:
                break                       # budget spent: only new hazards pass
            chosen.append((tier, e))
            spend += cost
        if not chosen:
            return 0
        self._allow -= spend                # urgent sends may overdraw the budget

        chosen.sort(key=lambda te: te[1].det.ts_ms)
        groups, cur = [], []
        for te in chosen:                   # keep each frame inside the dt range
            if cur and te[1].det.ts_ms - cur[0][1].det.ts_ms > SPAN_LIMIT_MS:
                groups.append(cur)
                cur = []
            cur.append(te)
        groups.append(cur)

        frames = 0
        for g in groups:
            flags = 0
            if any(cfg.repeats.get(e.det.class_id, 1) >= 3 for _, e in g):
                flags |= FLAG_CRITICAL
            if all(e.sends > 0 for _, e in g):
                flags |= FLAG_RETRANSMIT
            frames += self.sender.send([e.det for _, e in g], now_ms, flags)
            for tier, e in g:
                e.sends += 1
                e.last_sent_ms = now_ms
                self.stats[("new", "repeat", "refresh")[tier]] += 1
        self.stats["frames"] += frames
        return frames