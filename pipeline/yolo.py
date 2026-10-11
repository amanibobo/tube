"""Local fallback segmentation: YOLO11-seg + ByteTrack on MPS (else CPU)."""

import threading
from collections import Counter
from collections.abc import Callable
from pathlib import Path

import numpy as np

from pipeline.contours import mask_contour
from pipeline.trackable import COCO, COCO_ID

TRAFFIC = ["person", "bicycle", "car", "motorcycle", "bus", "truck"]
WEIGHTS = str(Path(__file__).resolve().parents[1] / "yolo11m-seg.pt")
PROGRESS_EVERY = 150
_ONE_AT_A_TIME = threading.Lock()  # concurrent MPS inference from two threads segfaults


def pick_device(model) -> str:
    try:
        model.predict(np.zeros((64, 64, 3), np.uint8), device="mps", verbose=False)
        return "mps"
    except Exception:  # noqa: BLE001  any MPS failure means fall back
        return "cpu"


def yolo_tracks(video: Path, info: dict, on_progress: Callable[[list[dict], int], None],
                track: list[dict] | None = None) -> list[dict]:
    """Raw tracks {source_class, label, frames}. With `track` ([{name, detector}]) only those detector classes
    are found and each track's label is the user's name; without it, the traffic classes with no label.
    Calls on_progress(tracks_so_far, frames_done) every PROGRESS_EVERY frames."""
    with _ONE_AT_A_TIME:
        return _yolo_tracks(video, info, on_progress, track)


LOOKALIKE_ANIMALS = ("dog", "cat", "cow", "horse", "sheep", "bear")


def _yolo_tracks(video: Path, info: dict, on_progress: Callable[[list[dict], int], None],
                 track: list[dict] | None) -> list[dict]:
    from ultralytics import YOLO

    labels = {}
    for t in track or []:
        labels.setdefault(t["detector"], t["name"])
    # YOLO often misreads one four-legged animal as another (a dog as "cow"), which breaks its track. When an animal
    # is asked for, accept the look-alikes too and give them the same label.
    for detector, name in list(labels.items()):
        if detector in LOOKALIKE_ANIMALS:
            for other in LOOKALIKE_ANIMALS:
                labels.setdefault(other, name)
    wanted = list(labels) if track else TRAFFIC
    model = YOLO(WEIGHTS)
    stream = model.track(source=str(video), stream=True, persist=True, tracker="bytetrack.yaml",
                         classes=[COCO_ID[c] for c in wanted], device=pick_device(model), retina_masks=True,
                         verbose=False)
    frames: dict[int, list] = {}
    votes: dict[int, Counter] = {}

    def snapshot() -> list[dict]:
        out = []
        for t, fr in frames.items():
            source = votes[t].most_common(1)[0][0]
            out.append({"source_class": source, "label": labels.get(source), "frames": fr})
        return out

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
