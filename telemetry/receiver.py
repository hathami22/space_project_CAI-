"""Receiver: decode, verify, de-duplicate, and track link health."""
from collections import deque
from typing import Callable, Optional
from .codec import decode_frame, frame_to_dict


class Receiver:
    def __init__(self, on_frame: Optional[Callable[[dict], None]] = None, window: int = 1024):
        self.on_frame = on_frame        # called with a dict for each NEW valid frame
        self.window = window            # bounded memory (flight-software style)
        self._seen = set()
        self._order = deque()
        self._max_seq = None            # raw 16-bit seq of the newest frame
        self._ext_max = None            # extended (non-wrapping) seq of the newest frame
        self._ext_first = None
        self.last_rx_ms = None
        self.first_rx_ms = None
        self.stats = {"datagrams": 0, "bytes_rx": 0, "crc_fail": 0,
                      "duplicates": 0, "reordered": 0, "unique": 0, "detections": 0}

    # --- sequence tracking -------------------------------------------------
    def _extend(self, seq: int) -> int:
        """Turn a wrapping 16-bit seq into a monotonically comparable integer."""
        if self._max_seq is None:
            self._max_seq = self._ext_max = self._ext_first = seq
            return seq
        delta = (seq - self._max_seq) & 0xFFFF
        if delta == 0:
            return self._ext_max
        if delta < 0x8000:                      # newer frame
            self._ext_max += delta
            self._max_seq = seq
            return self._ext_max
        return self._ext_max - ((self._max_seq - seq) & 0xFFFF)   # older frame

    def _remember(self, ext: int) -> None:
        self._seen.add(ext)
        self._order.append(ext)
        if len(self._order) > self.window:
            self._seen.discard(self._order.popleft())

    # --- main entry point --------------------------------------------------
    def on_packet(self, data: bytes, now_ms: int) -> Optional[dict]:
        s = self.stats
        s["datagrams"] += 1
        s["bytes_rx"] += len(data)

        frame = decode_frame(data)
        if frame is None:
            s["crc_fail"] += 1
            return None

        self.last_rx_ms = now_ms                # any valid frame counts as contact
        if self.first_rx_ms is None:
            self.first_rx_ms = now_ms

        ext = self._extend(frame.seq)
        if ext in self._seen:
            s["duplicates"] += 1
            return None
        if ext < self._ext_max:
            s["reordered"] += 1
        self._remember(ext)
        s["unique"] += 1
        s["detections"] += len(frame.detections)

        out = frame_to_dict(frame)
        out["rx_ms"] = now_ms
        if self.on_frame:
            self.on_frame(out)
        return out

    # --- link health (for Person C's link panel) ---------------------------
    @property
    def expected(self) -> int:
        return 0 if self._ext_max is None else self._ext_max - self._ext_first + 1

    @property
    def lost(self) -> int:
        return max(0, self.expected - self.stats["unique"])

    def loss_fraction(self) -> float:
        return self.lost / self.expected if self.expected else 0.0

    def link_status(self, now_ms: int) -> dict:
        return {
            "expected": self.expected,
            "received": self.stats["unique"],
            "lost": self.lost,
            "loss_pct": round(100 * self.loss_fraction(), 1),
            "crc_fail": self.stats["crc_fail"],
            "duplicates": self.stats["duplicates"],
            "reordered": self.stats["reordered"],
            "bytes_rx": self.stats["bytes_rx"],
            "last_rx_ms": self.last_rx_ms,
            "since_last_rx_ms": None if self.last_rx_ms is None else now_ms - self.last_rx_ms,
        }
    