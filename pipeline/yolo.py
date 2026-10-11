"""Local fallback segmentation: YOLO11-seg + ByteTrack on MPS (else CPU)."""

from collections import Counter
from collections.abc import Callable
from pathlib import Path

import numpy as np

from pipeline.contours import mask_contour

COCO = {0: "person", 1: "bicycle", 2: "car", 3: "motorcycle", 5: "bus", 7: "truck"}
WEIGHTS = str(Path(__file__).resolve().parents[1] / "yolo11m-seg.pt")
PROGRESS_EVERY = 150


def pick_device(model) -> str:
    try:
        model.predict(np.zeros((64, 64, 3), np.uint8), device="mps", verbose=False)
        return "mps"
    except Exception:  # noqa: BLE001  any MPS failure means fall back
        return "cpu"


def yolo_tracks(video: Path, info: dict, on_progress: Callable[[list[dict], int], None]) -> list[dict]:
    """Raw tracks {source_class, frames}; calls on_progress(tracks_so_far, frames_done) every PROGRESS_EVERY."""
    from ultralytics import YOLO

    model = YOLO(WEIGHTS)
    stream = model.track(source=str(video), stream=True, persist=True, tracker="bytetrack.yaml",
                         classes=list(COCO), device=pick_device(model), retina_masks=True, verbose=False)
    frames: dict[int, list] = {}
    votes: dict[int, Counter] = {}

    def snapshot() -> list[dict]:
        return [{"source_class": votes[t].most_common(1)[0][0], "frames": fr} for t, fr in frames.items()]

    for f, r in enumerate(stream):
        if f and f % PROGRESS_EVERY == 0:
            on_progress(snapshot(), f)
        if r.boxes.id is None or r.masks is None:
            continue
        masks = r.masks.data.cpu().numpy() > 0.5
        for tid, cls, xyxy, mask in zip(r.boxes.id.int().tolist(), r.boxes.cls.int().tolist(),
                                         r.boxes.xyxy.round().int().tolist(), masks, strict=True):
            shape = mask_contour(mask)
            if shape is None:
                continue
            contour, centroid = shape
            frames.setdefault(tid, []).append({"f": f, "bbox": xyxy, "centroid": centroid, "contour": contour})
            votes.setdefault(tid, Counter())[COCO[cls]] += 1
    on_progress(snapshot(), info["frames"])
    return snapshot()
