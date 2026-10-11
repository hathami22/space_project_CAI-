from telemetry.codec import (
    Detection, encode_frame, decode_frame, frame_to_dict,
    FLAG_CRITICAL, MAX_DETECTIONS, sigma_to_code, code_to_sigma,
)


def sample():
    return [
        Detection(0, 6, 350, -120, 123456, 15),
        Detection(1, 5, -800, 1500, 123756, 57),
    ]


def test_size_is_24_bytes():
    assert len(encode_frame(42, sample(), FLAG_CRITICAL)) == 24


def test_known_header_and_detection_bytes():
    f = encode_frame(42, sample(), FLAG_CRITICAL)
    assert f[:8] == bytes.fromhex("11002A0001E24002")
    assert f[8] == 0x18 and f[15] == 0x34
    assert f[9:13] == bytes.fromhex("015EFF88")
    assert f[16:20] == bytes.fromhex("FCE005DC")
    assert f[20] == 3  # dt = 300 ms


def test_roundtrip():
    frame = decode_frame(encode_frame(42, sample(), FLAG_CRITICAL))
    assert frame is not None and frame.seq == 42
    d0, d1 = frame.detections
    assert (d0.class_id, d0.conf, d0.x_cm, d0.y_cm, d0.ts_ms) == (0, 6, 350, -120, 123456)
    assert (d1.class_id, d1.conf, d1.x_cm, d1.y_cm, d1.ts_ms) == (1, 5, -800, 1500, 123756)
    assert abs(d0.sigma_cm - 15) / 15 < 0.05   # log quantization error < 5%
    assert frame_to_dict(frame)["critical"] is True


def test_corrupted_frame_rejected():
    data = bytearray(encode_frame(1, sample()))
    for i in range(len(data)):
        for bit in range(8):                    # every single-bit flip
            bad = bytearray(data)
            bad[i] ^= 1 << bit
            assert decode_frame(bytes(bad)) is None


def test_truncated_and_garbage_rejected():
    data = encode_frame(1, sample())
    assert decode_frame(data[:-1]) is None
    assert decode_frame(b"") is None
    assert decode_frame(b"\x00" * 30) is None


def test_seq_wraps():
    assert decode_frame(encode_frame(65536 + 5, sample())).seq == 5


def test_max_batch():
    dets = [Detection(0, 3, i, i, 1000, 20) for i in range(MAX_DETECTIONS)]
    assert len(encode_frame(0, dets)) == 8 + 7 * MAX_DETECTIONS + 2


def test_sigma_monotonic():
    assert sigma_to_code(10) < sigma_to_code(100) < sigma_to_code(1000)
    assert abs(code_to_sigma(0) - 5) < 1e-6