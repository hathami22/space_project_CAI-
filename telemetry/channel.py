"""In-process channel with a simulated clock (deterministic, instant)."""
import heapq
from .link import LossyLink
from .receiver import Receiver


class SimChannel:
    def __init__(self, link: LossyLink, receiver: Receiver):
        self.link = link
        self.receiver = receiver
        self._heap = []
        self._n = 0                      # tie-breaker keeps heap order stable

    def send(self, data: bytes, now_ms: int) -> None:
        """Use as Sender's send_fn."""
        for t, d in self.link.transmit(data, now_ms):
            heapq.heappush(self._heap, (t, self._n, d))
            self._n += 1

    def advance(self, now_ms: int) -> None:
        """Deliver every packet whose arrival time has come."""
        while self._heap and self._heap[0][0] <= now_ms:
            t, _, d = heapq.heappop(self._heap)
            self.receiver.on_packet(d, t)
            