"""The upload job: four resumable stages over one dataset directory, with progress in meta.json.

Each finished stage is recorded in meta["done"], and each stage writes its outputs whole before that, so a job
interrupted at any point resumes at the first unfinished stage and redoes only that one.
"""

import gzip
import json
import os
import subprocess
import time
from collections.abc import Callable
from pathlib import Path
from typing import Protocol

from pipeline import media
from pipeline.build import build_tracks
from pipeline.derive import write_dataset, write_json


class Reporter(Protocol):
    def stage(self, name: str, message: str) -> None: ...
    def progress(self, fraction: float) -> None: ...
    def tubes(self, frames_done: int, n_tracks: int) -> None: ...


class JobFailed(Exception):
    """A plain sentence for meta.error."""


def read_meta(root: Path) -> dict:
    return json.loads((root / "meta.json").read_text())


def write_meta(root: Path, meta: dict) -> None:
    tmp = root / "meta.json.tmp"
    tmp.write_text(json.dumps(meta, indent=1))
    tmp.replace(root / "meta.json")


REPORTER_FIELDS = ("progress", "message")


def update_meta(root: Path, **fields) -> dict:
    """Read, update only the given fields, write whole. The job and its reporter each own different fields."""
    meta = read_meta(root)
    meta.update(fields)
    write_meta(root, meta)
    return meta


def new_meta(video_id: str, title: str, source: str, **extra) -> dict:
    return {"id": video_id, "title": title, "status": "queued", "stage": None, "progress": 0.0, "error": None,
            "created": time.time(), "duration_s": None, "credit": "", "source": source, "done": [], **extra}


def normalizing(root: Path, meta: dict, report: Reporter) -> None:
    if meta["source"] == "clip":
        try:
            media.normalize_video(meta["source_url"], root / "video.mp4", meta["clip_end"] - meta["clip_start"],
                                  start=meta["clip_start"], remote=True)
        except subprocess.CalledProcessError as e:
            raise JobFailed("Couldn't read the video from the archive. Try sending the moment again.") from e
    else:
        src = Path(meta["source_file"])
        if not src.exists():
            raise JobFailed("The uploaded file is missing. Please upload the video again.")
        media.normalize_video(src, root / "video.mp4", meta.get("max_seconds", media.MAX_SECONDS))
    report.progress(0.5)
    n = media.write_thumbnails(root / "video.mp4", root / "frames")
    info = media.probe(root / "video.mp4")
    meta.update(duration_s=round(n / info["fps"], 2), fps=info["fps"], width=info["width"],
                height=info["height"], frames=n)
    if meta.get("source_file") and not meta.get("keep_source"):
        Path(meta["source_file"]).unlink(missing_ok=True)
    # an empty partial cube, so the viewer can show the video, volume and frame plane while segmenting runs
    write_json(root / "tubes.json", {"video": {**video_block(root, meta), "partial": True, "frames_done": 0},
                                     "tracks": []})
    report.tubes(0, 0)


def video_block(root: Path, meta: dict) -> dict:
    return {"id": meta["id"], "fps": round(meta["fps"], 3), "width": meta["width"], "height": meta["height"],
            "frames": meta["frames"], "thumb_stride": media.THUMB_STRIDE, "thumb_width": media.THUMB_WIDTH,
            "credit": meta.get("credit", "")}


def segmenting(root: Path, meta: dict, report: Reporter) -> None:
    from pipeline.yolo import yolo_tracks

    info = {k: meta[k] for k in ("fps", "width", "height", "frames")} | {"duration": meta["duration_s"]}
    backend = os.environ.get("TUBEWATCH_BACKEND", "auto")
    run: Callable = yolo_tracks
    if backend in ("auto", "sam3"):
        from pipeline import sam3_modal

        ok, why = sam3_modal.available()
        if ok:
            run, meta["backend"] = sam3_modal.sam3_tracks, "sam3"
        elif backend == "sam3":
            raise JobFailed(f"{why}.")
        else:
            report.stage("segmenting", f"{why}; using YOLO on this machine.")
    meta.setdefault("backend", "yolo")

    def partial(raw: list[dict], frames_done: int) -> None:
        tracks = build_tracks(raw, meta["fps"])
        write_json(root / "tubes.json", {"video": {**video_block(root, meta), "partial": True,
                                                   "frames_done": frames_done}, "tracks": tracks})
        report.progress(frames_done / meta["frames"])
        report.tubes(frames_done, len(tracks))

    raw = run(root / "video.mp4", info, partial)
    tmp = root / "segments.json.gz.tmp"
    tmp.write_bytes(gzip.compress(json.dumps({"backend": meta["backend"], "tracks": raw}).encode()))
    tmp.replace(root / "segments.json.gz")


def building(root: Path, meta: dict, report: Reporter) -> None:
    raw = json.loads(gzip.decompress((root / "segments.json.gz").read_bytes()))["tracks"]
    tracks = build_tracks(raw, meta["fps"])
    write_dataset(root, {"video": video_block(root, meta), "tracks": tracks})
    if not (root / "zones.json").exists():
        write_json(root / "zones.json", [])
    report.tubes(meta["frames"], len(tracks))


def indexing(root: Path, meta: dict, report: Reporter) -> None:
    from server.agent import Agent
    from server.tools import load_dataset

    Agent(load_dataset(root)).seed_demo()


STAGES: list[tuple[str, float, Callable[[Path, dict, Reporter], None], str]] = [
    ("normalizing", 0.15, normalizing, "Preparing the video"),
    ("segmenting", 0.70, segmenting, "Finding cars, people and bicycles"),
    ("building", 0.10, building, "Building tubes"),
    ("indexing", 0.05, indexing, "Getting answers ready"),
]


def stage_span(name: str) -> tuple[float, float]:
    """(start, width) of a stage within the job's 0..1 progress."""
    start = 0.0
    for n, weight, _, _ in STAGES:
        if n == name:
            return start, weight
        start += weight
    raise KeyError(name)


def run(root: Path, report: Reporter) -> dict:
    """Run every unfinished stage, persisting meta after each. Raises JobFailed with a plain sentence."""
    meta = read_meta(root)

    def save(**fields) -> None:
        meta.update(fields)
        update_meta(root, **{k: v for k, v in meta.items() if k not in REPORTER_FIELDS})

    for name, _, fn, message in STAGES:
        if name in meta["done"]:
            continue
        save(status="processing", stage=name)
        report.stage(name, message)
        fn(root, meta, report)
        save(done=[*meta["done"], name])
    save(status="ready", stage=None, error=None)
    return update_meta(root, progress=1.0, message="Ready")
