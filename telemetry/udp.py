"""Real UDP transport. The link emulator runs sender-side with the wall clock."""
import asyncio
import time
from .link import LossyLink
from .receiver import Receiver


class MissionClock:
    """Mission elapsed time in ms (shared by sender and receiver in the demo)."""
    def __init__(self):
        self._t0 = time.monotonic()

    def now_ms(self) -> int:
        return int((time.monotonic() - self._t0) * 1000)


class _RxProtocol(asyncio.DatagramProtocol):
    def __init__(self, receiver: Receiver, clock):
        self.receiver, self.clock = receiver, clock

    def datagram_received(self, data, addr):
        self.receiver.on_packet(data, self.clock())


async def start_receiver(receiver: Receiver, host="127.0.0.1", port=9000, clock=None):
    """Listen for UDP datagrams. Returns the transport (call .close() to stop)."""
    clock = clock or MissionClock().now_ms
    loop = asyncio.get_running_loop()
    transport, _ = await loop.create_datagram_endpoint(
        lambda: _RxProtocol(receiver, clock), local_addr=(host, port))
    return transport


class UdpTransport:
    """Applies the lossy link, then sends over a real UDP socket."""
    def __init__(self, link: LossyLink, transport, loop):
        self.link, self.transport, self.loop = link, transport, loop

    def send(self, data: bytes, now_ms: int) -> None:
        """Use as Sender's send_fn."""
        for t, d in self.link.transmit(data, now_ms):
            delay = max(0, t - now_ms) / 1000
            if delay == 0:
                self.transport.sendto(d)
            else:
                self.loop.call_later(delay, self.transport.sendto, d)


async def open_udp_transport(link: LossyLink, host="127.0.0.1", port=9000) -> UdpTransport:
    loop = asyncio.get_running_loop()
    transport, _ = await loop.create_datagram_endpoint(
        asyncio.DatagramProtocol, remote_addr=(host, port))
    return UdpTransport(link, transport, loop)
