"""Telemetry codec: compact binary frames for the lunar rover link.

Frame layout (big-endian, no padding):
  HEADER (8 B):  ver_flags(B) seq(H) base_ts_ms(I) count(B)
  DETECTION (7 B each): class_conf(B) x_cm(h) y_cm(h) dt_100ms(B) sigma_code(B)
  TRAILER (2 B): crc16 over everything before it

ver_flags : high 4 bits = version, low 4 bits = flags
class_conf: bits 7-5 = class, bits 4-2 = confidence (0-7), bits 1-0 spare
sigma_code: 0-255 on a log scale, 5 cm .. 5000 cm
"""
import binascii
import math
import struct
from dataclasses import dataclass, field
from typing import List, Optional

VERSION = 1
HEADER_FMT = ">BHIB"
DET_FMT = ">BhhBB"
CRC_FMT = ">H"
HEADER_SIZE = struct.calcsize(HEADER_FMT)  # 8
DET_SIZE = struct.calcsize(DET_FMT)        # 7
CRC_SIZE = struct.calcsize(CRC_FMT)        # 2
MAX_DETECTIONS = 32  # bounded frame size: 8 + 32*7 + 2 = 234 B

# Flags (low 4 bits of ver_flags)
FLAG_CRITICAL = 0x1
FLAG_SAFE_MODE = 0x2
FLAG_RETRANSMIT = 0x4

# Class ids (agree these with Person A)
CLASS_BOULDER, CLASS_CRATER, CLASS_ICE, CLASS_BEACON = 0, 1, 2, 3
CLASS_NAMES = {0: "boulder", 1: "crater", 2: "ice", 3: "beacon"}

SIGMA_MIN_CM = 5.0
SIGMA_MAX_CM = 5000.0
DT_UNIT_MS = 100


@dataclass
class Detection:
    class_id: int
    conf: int          # 0-7
    x_cm: int
    y_cm: int
    ts_ms: int         # mission elapsed time of the detection
    sigma_cm: float    # position uncertainty


@dataclass
class Frame:
    seq: int
    flags: int
    base_ts_ms: int
    detections: List[Detection] = field(default_factory=list)
    version: int = VERSION


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


def quantize_conf(p: float) -> int:
    """Map a 0.0-1.0 confidence to 0-7."""
    return _clamp(int(round(p * 7)), 0, 7)


def sigma_to_code(sigma_cm: float) -> int:
    s = _clamp(sigma_cm, SIGMA_MIN_CM, SIGMA_MAX_CM)
    return int(round(255 * math.log(s / SIGMA_MIN_CM) / math.log(SIGMA_MAX_CM / SIGMA_MIN_CM)))


def code_to_sigma(code: int) -> float:
    return SIGMA_MIN_CM * (SIGMA_MAX_CM / SIGMA_MIN_CM) ** (code / 255)


def crc16(data: bytes) -> int:
    return binascii.crc_hqx(data, 0xFFFF)


def encode_frame(seq: int, detections: List[Detection], flags: int = 0) -> bytes:
    if not 1 <= len(detections) <= MAX_DETECTIONS:
        raise ValueError(f"need 1..{MAX_DETECTIONS} detections, got {len(detections)}")
    base_ts = min(d.ts_ms for d in detections)
    ver_flags = ((VERSION & 0xF) << 4) | (flags & 0xF)
    body = struct.pack(HEADER_FMT, ver_flags, seq & 0xFFFF, base_ts & 0xFFFFFFFF, len(detections))
    for d in detections:
        class_conf = ((d.class_id & 0x7) << 5) | ((_clamp(d.conf, 0, 7) & 0x7) << 2)
        dt = _clamp((d.ts_ms - base_ts) // DT_UNIT_MS, 0, 255)
        body += struct.pack(
            DET_FMT,
            class_conf,
            _clamp(int(d.x_cm), -32768, 32767),
            _clamp(int(d.y_cm), -32768, 32767),
            dt,
            sigma_to_code(d.sigma_cm),
        )
    return body + struct.pack(CRC_FMT, crc16(body))


def decode_frame(data: bytes) -> Optional[Frame]:
    """Return a Frame, or None if the data is corrupted or malformed."""
    if len(data) < HEADER_SIZE + CRC_SIZE:
        return None
    body, (rx_crc,) = data[:-CRC_SIZE], struct.unpack(CRC_FMT, data[-CRC_SIZE:])
    if crc16(body) != rx_crc:
        return None
    ver_flags, seq, base_ts, count = struct.unpack(HEADER_FMT, body[:HEADER_SIZE])
    version, flags = ver_flags >> 4, ver_flags & 0xF
    if version != VERSION or not 1 <= count <= MAX_DETECTIONS:
        return None
    if len(body) != HEADER_SIZE + count * DET_SIZE:
        return None
    dets = []
    for i in range(count):
        off = HEADER_SIZE + i * DET_SIZE
        class_conf, x, y, dt, sig = struct.unpack(DET_FMT, body[off:off + DET_SIZE])
        dets.append(Detection(
            class_id=class_conf >> 5,
            conf=(class_conf >> 2) & 0x7,
            x_cm=x, y_cm=y,
            ts_ms=base_ts + dt * DT_UNIT_MS,
            sigma_cm=code_to_sigma(sig),
        ))
    return Frame(seq=seq, flags=flags, base_ts_ms=base_ts, detections=dets, version=version)


def frame_to_dict(f: Frame) -> dict:
    """Clean dict for Person C's dashboard."""
    return {
        "seq": f.seq,
        "critical": bool(f.flags & FLAG_CRITICAL),
        "safe_mode": bool(f.flags & FLAG_SAFE_MODE),
        "retransmit": bool(f.flags & FLAG_RETRANSMIT),
        "detections": [
            {
                "class": CLASS_NAMES.get(d.class_id, f"class{d.class_id}"),
                "conf": d.conf,
                "x_cm": d.x_cm,
                "y_cm": d.y_cm,
                "ts_ms": d.ts_ms,
                "sigma_cm": round(d.sigma_cm, 1),
            }
            for d in f.detections
        ],
    }