import pytest

cv2 = pytest.importorskip("cv2")
np = pytest.importorskip("numpy")

from telemetry.perception_live import boxes_to_detections, classical_detect, pixel_to_ground


def test_image_centre_projects_straight_ahead():
    x, y = pixel_to_ground(320, 240, 640, 480)
    assert abs(x) < 1e-6 and y == pytest.approx(567.1, abs=0.5)    # 100 cm / sin(10 deg) * cos(10 deg)


def test_above_horizon_has_no_ground_point():
    assert pixel_to_ground(320, 0, 640, 480) is None


def test_lower_pixels_are_closer_and_right_pixels_are_right():
    assert pixel_to_ground(320, 400, 640, 480)[1] < pixel_to_ground(320, 300, 640, 480)[1]
    assert pixel_to_ground(500, 300, 640, 480)[0] > 0 > pixel_to_ground(100, 300, 640, 480)[0]


def test_far_detections_get_larger_sigma():
    (near,) = boxes_to_detections([(0, 0.9, (300, 300, 340, 400))], (480, 640))
    (far,) = boxes_to_detections([(0, 0.9, (300, 270, 340, 290))], (480, 640))
    assert far.y_cm > near.y_cm and far.sigma_cm > near.sigma_cm


def test_boxes_to_detections_types_and_confidence():
    (d,) = boxes_to_detections([(1, 0.5, (300, 300, 340, 380))], (480, 640), t_ms=1234)
    assert d.class_id == 1 and d.conf == 4 and d.ts_ms == 1234     # round(0.5 * 7) = 4
    assert all(isinstance(v, (int, float)) for v in (d.x_cm, d.y_cm, d.sigma_cm))


def test_classical_detector_runs_and_finds_a_dark_rock():
    rng = np.random.default_rng(0)
    img = np.zeros((360, 640, 3), np.uint8)
    img[120:] = 60 + rng.integers(0, 12, (240, 640, 1))             # lit ground, black sky
    cv2.ellipse(img, (200, 260), (40, 25), 0, 0, 360, (15, 15, 15), -1)
    boxes = classical_detect(img)
    assert any(x1 < 200 < x2 and y1 < 260 < y2 for _, _, (x1, y1, x2, y2) in boxes)
    assert classical_detect(np.zeros((360, 640, 3), np.uint8)) == []   # empty dark frame