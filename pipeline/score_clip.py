"""Score candidate clips for the demo: people, moving vehicles, close passes, and camera stability.

Run: python -m pipeline.score_clip data/raw/*/*.mp4 [--samples 30]

Per sampled time t it detects on frames t and t + 0.5 s (long side scaled to 1280):
- people: person detections per frame
- moving: vehicles whose best box IoU half a second later is under 0.5
- close: share of frames where a person's box is within one median person height of a moving vehicle
- shift: median phase-correlation shift in px between t and t + 0.5 s (pans, wobble)
- drift: mean abs grey difference outside detections versus the first sample (zooms, cuts, slow pans)
"""

import argparse
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO

PERSON, VEHICLES = 0, {2, 3, 5, 7}
SIDE = 1280
DEVICE = "mps"


def read(cap: cv2.VideoCapture, t: float) -> np.ndarray | None:
    cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
    ok, img = cap.read()
    if not ok:
        return None
    s = SIDE / max(img.shape[:2])
    return cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)


def iou(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    x0, y0 = np.maximum(a[:, None, 0], b[None, :, 0]), np.maximum(a[:, None, 1], b[None, :, 1])
    x1, y1 = np.minimum(a[:, None, 2], b[None, :, 2]), np.minimum(a[:, None, 3], b[None, :, 3])
    inter = np.clip(x1 - x0, 0, None) * np.clip(y1 - y0, 0, None)
    area = lambda r: (r[:, 2] - r[:, 0]) * (r[:, 3] - r[:, 1])  # noqa: E731
    return inter / (area(a)[:, None] + area(b)[None, :] - inter)


def box_gap(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    gx = np.maximum(0, np.maximum(a[:, None, 0] - b[None, :, 2], b[None, :, 0] - a[:, None, 2]))
    gy = np.maximum(0, np.maximum(a[:, None, 1] - b[None, :, 3], b[None, :, 1] - a[:, None, 3]))
    return np.hypot(gx, gy)


def detect(model: YOLO, img: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    r = model.predict(img, classes=[PERSON, *VEHICLES], conf=0.3, device=DEVICE, verbose=False)[0]
    xyxy, cls = r.boxes.xyxy.cpu().numpy(), r.boxes.cls.cpu().numpy().astype(int)
    return xyxy[cls == PERSON], xyxy[np.isin(cls, list(VEHICLES))]


def background(img: np.ndarray, boxes: np.ndarray) -> np.ndarray:
    grey = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    mask = np.ones(grey.shape, bool)
    for x0, y0, x1, y1 in boxes.astype(int):
        mask[max(0, y0):y1, max(0, x0):x1] = False
    return np.where(mask, grey, np.nan)


def score(path: Path, model: YOLO, samples: int) -> dict:
    cap = cv2.VideoCapture(str(path))
    duration = cap.get(cv2.CAP_PROP_FRAME_COUNT) / cap.get(cv2.CAP_PROP_FPS)
    people, moving, close, heights, shifts, drifts = [], [], [], [], [], []
    first_bg = None
    for t in np.linspace(0.5, duration - 1.0, samples):
        a, b = read(cap, t), read(cap, t + 0.5)
        if a is None or b is None:
            continue
        pa, va = detect(model, a)
        _, vb = detect(model, b)
        moved = va[iou(va, vb).max(1) < 0.5] if len(va) and len(vb) else va
        people.append(len(pa))
        moving.append(len(moved))
        heights += list(pa[:, 3] - pa[:, 1])
        ga, gb = (cv2.cvtColor(x, cv2.COLOR_BGR2GRAY).astype(np.float32) for x in (a, b))
        shifts.append(float(np.hypot(*cv2.phaseCorrelate(ga, gb)[0])))
        bg = background(a, np.vstack([pa, va]) if len(pa) or len(va) else np.zeros((0, 4)))
        first_bg = bg if first_bg is None else first_bg
        drifts.append(float(np.nanmean(np.abs(bg - first_bg))))
        close.append(bool(len(pa) and len(moved) and (box_gap(pa, moved) < np.median(heights)).any()))
    return {
        "clip": str(path), "seconds": round(duration, 1),
        "people": round(float(np.mean(people)), 1), "moving": round(float(np.mean(moving)), 1),
        "close": round(float(np.mean(close)), 2), "person_h": round(float(np.median(heights)), 1) if heights else 0,
        "shift": round(float(np.median(shifts)), 2), "drift": round(float(np.median(drifts)), 1),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("clips", nargs="+", type=Path)
    ap.add_argument("--samples", type=int, default=30)
    ap.add_argument("--model", default="yolo11m.pt")
    args = ap.parse_args()
    model = YOLO(args.model)
    cols = ["clip", "seconds", "people", "moving", "close", "person_h", "shift", "drift"]
    print(" | ".join(cols))
    for clip in args.clips:
        print(" | ".join(str(v) for v in score(clip, model, args.samples).values()), flush=True)


if __name__ == "__main__":
    main()
