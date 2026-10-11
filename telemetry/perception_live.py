"""Person A's hybrid detector, extracted from the notebook so it runs outside Kaggle.

  rocks (class 0)        -> fine-tuned YOLOv8n  (best.pt)
  pits (1) / bright (2)  -> classical CV rules (CLAHE + adaptive threshold + contours)
  pixel -> ground (cm)   -> flat-ground pinhole model

CAMERA GEOMETRY IS AN ASSUMPTION (copied from A's notebook) - confirm with Person A.

Usage:
    from telemetry.perception_live import Perception, load_frames
    from telemetry.perception_adapter import PerceptionRover
    p = Perception("best.pt")                     # needs: pip install ultralytics opencv-python
    frames = load_frames("path/to/images_or_video.mp4", n=100)
    rover = PerceptionRover.from_detector(p.detect_b, frames)
"""
import glob
import os
from typing import List

import cv2
import numpy as np

from .codec import Detection

TARGET_W = 640
CAM_H_CM, CAM_PITCH_DEG, HFOV_DEG, PIX_ERR = 100.0, 10.0, 70.0, 2.0

_clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
_KERNEL = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))


# --- frame loading ---------------------------------------------------------
def _resize(im, width=TARGET_W):
    s = width / im.shape[1]
    return cv2.resize(im, (width, int(im.shape[0] * s)), interpolation=cv2.INTER_AREA)


def load_frames(path: str, n: int = 100, width: int = TARGET_W) -> list:
    """Load up to n BGR frames, resized to `width`. `path` = video file or folder of images."""
    frames = []
    if os.path.isdir(path):
        files = sorted(glob.glob(os.path.join(path, "**", "*.png"), recursive=True)
                       + glob.glob(os.path.join(path, "**", "*.jpg"), recursive=True))
        for f in files[:n]:
            im = cv2.imread(f)
            if im is not None:
                frames.append(_resize(im, width))
    else:
        cap = cv2.VideoCapture(path)
        while len(frames) < n:
            ok, im = cap.read()
            if not ok:
                break
            frames.append(_resize(im, width))
        cap.release()
    if not frames:
        raise IOError(f"no frames loaded from {path}")
    return frames


# --- classical detector (A's cells 'detect' / 'find_horizon') -----------------
def _find_horizon(gray):
    rows = np.convolve(gray.mean(axis=1), np.ones(9) / 9, mode="same")
    idx = np.where(rows > 15)[0]
    return int(idx[0]) if len(idx) else 0


def classical_detect(frame_bgr, min_area_frac=0.0005, max_area_frac=0.25):
    """Returns [(class_id, confidence 0-1, (x1, y1, x2, y2))] for rocks(0)/pits(1)/bright(2)."""
    h, w = frame_bgr.shape[:2]
    gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
    horizon = _find_horizon(gray)
    g = cv2.GaussianBlur(_clahe.apply(gray), (5, 5), 0)
    dark = cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 31, 8)
    bright = cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, -8)
    mask = cv2.bitwise_or(dark, bright)
    mask[:horizon, :] = 0
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, _KERNEL)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, _KERNEL, iterations=2)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    frame_area = float(h * w)
    ground_mean = gray[horizon:, :].mean() if horizon < h else gray.mean()
    out = []
    for c in contours:
        area = cv2.contourArea(c)
        if area < min_area_frac * frame_area or area > max_area_frac * frame_area:
            continue
        per = cv2.arcLength(c, True)
        if per == 0:
            continue
        circ = 4 * np.pi * area / (per * per)
        hull_area = cv2.contourArea(cv2.convexHull(c))
        solidity = area / hull_area if hull_area > 0 else 0
        x, y, bw, bh = cv2.boundingRect(c)
        blob = np.zeros((h, w), np.uint8)
        cv2.drawContours(blob, [c], -1, 255, -1)
        mean_int = cv2.mean(gray, mask=blob)[0]
        if mean_int > 200 and solidity > 0.8:
            cls = 2
        elif circ > 0.75 and area > 0.01 * frame_area and mean_int < 0.7 * ground_mean:
            cls = 1
        else:
            cls = 0
        conf = float(min(1.0, 0.5 * solidity + 0.5 * min(area / (0.02 * frame_area), 1.0)))
        out.append((cls, conf, (float(x), float(y), float(x + bw), float(y + bh))))
    return out


# --- geometry --------------------------------------------------------------
def pixel_to_ground(u, v, w, h):
    """Flat-ground pinhole model -> (x_east_cm, y_north_cm), or None above the horizon."""
    f = (w / 2) / np.tan(np.radians(HFOV_DEG) / 2)
    dx, dy = (u - w / 2) / f, (v - h / 2) / f
    p = np.radians(CAM_PITCH_DEG)
    down, fwd = dy * np.cos(p) + np.sin(p), np.cos(p) - dy * np.sin(p)
    if down <= 1e-6:
        return None
    t = CAM_H_CM / down
    return float(t * dx), float(t * fwd)


# --- hybrid detector -------------------------------------------------------
class Perception:
    def __init__(self, weights="best.pt", device="cpu", conf_thr=0.25, imgsz=640):
        from ultralytics import YOLO          # imported here so the rest works without torch
        self.model = YOLO(weights)
        self.device, self.conf_thr, self.imgsz = device, conf_thr, imgsz

    def _candidates(self, frame_bgr):
        res = self.model.predict(frame_bgr, imgsz=self.imgsz, conf=self.conf_thr,
                                 device=self.device, verbose=False)[0]
        cand = [(0, float(c), tuple(map(float, b)))
                for b, c in zip(res.boxes.xyxy.cpu().numpy(), res.boxes.conf.cpu().numpy())]
        cand += [(cid, cf, box) for cid, cf, box in classical_detect(frame_bgr) if cid in (1, 2)]
        return cand

    def detect_b(self, frame_bgr, t_ms: int = 0) -> List[Detection]:
        return boxes_to_detections(self._candidates(frame_bgr), frame_bgr.shape[:2], t_ms)


def boxes_to_detections(cand, shape_hw, t_ms=0) -> List[Detection]:
    """[(class_id, conf 0-1, (x1,y1,x2,y2))] -> rover-relative codec Detections."""
    h, w = shape_hw
    out = []
    for cid, cf, (x1, y1, x2, y2) in cand:
        u, v = (x1 + x2) / 2, y2                       # bottom-centre = ground contact point
        g = pixel_to_ground(u, v, w, h)
        if g is None:
            continue
        g2 = pixel_to_ground(u, min(v + PIX_ERR, h - 1), w, h)
        sigma = float(np.hypot(g[0] - g2[0], g[1] - g2[1])) if g2 else 50.0
        out.append(Detection(int(cid), int(round(min(max(cf, 0), 1) * 7)),
                             round(g[0], 1), round(g[1], 1), int(t_ms), round(max(sigma, 1.0), 1)))
    return out
