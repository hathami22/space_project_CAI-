"""Sender: encodes detections into frames and hands them to a transport."""
from typing import Callable, List
from .codec import Detection, encode_frame, MAX_DETECTIONS


class Sender:
    def __init__(self, send_fn: Callable[[bytes, int], None], start_seq: int = 0):
        self.send_fn = send_fn          # send_fn(data, now_ms)
        self.seq = start_seq & 0xFFFF
        self.stats = {"frames": 0, "bytes": 0, "detections": 0}

    def send(self, detections: List[Detection], now_ms: int, flags: int = 0) -> int:
        """Encode (splitting into several frames if needed) and transmit.
        Returns the number of frames sent."""
        frames = 0
        for i in range(0, len(detections), MAX_DETECTIONS):
            chunk = detections[i:i + MAX_DETECTIONS]
            data = encode_frame(self.seq, chunk, flags)
            self.seq = (self.seq + 1) & 0xFFFF
            self.send_fn(data, now_ms)
            self.stats["frames"] += 1
            self.stats["bytes"] += len(data)
            self.stats["detections"] += len(chunk)
            frames += 1
        return frames