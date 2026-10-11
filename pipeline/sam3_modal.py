"""SAM 3 text-prompted video segmentation on Modal, in parallel chunks.

Deploy once (needs the Modal secret "huggingface" holding HF_TOKEN for the gated facebook/sam3 weights):

    modal deploy -m pipeline.sam3_modal      (from the repo root)

Weights download once into the Modal Volume "tubewatch-sam3-weights" (HF_HOME points there inside the
container); nothing is downloaded on this machine. The server looks the deployed class up by name, so when
the app isn't deployed or Modal is unreachable, available() is False and the job falls back to YOLO.

API used (facebookresearch/sam3 at SAM3_COMMIT, sam3/model/sam3_base_predictor.py): handle_request
start_session(resource_path) -> add_prompt(frame_index, text) -> handle_stream_request propagate_in_video,
yielding {frame_index, outputs: {out_obj_ids, out_probs, out_boxes_xywh, out_binary_masks}} -> close_session.
"""

import os
import subprocess
import tempfile
import time
from collections.abc import Callable
from pathlib import Path

import modal

from pipeline.chunks import SAMPLE_FPS, Chunk, densify, plan_chunks, stitch, to_tracks

# Deploy-time configuration (defaults are production). The values are baked into the image env as well, so the
# container re-imports this module with the same settings it was deployed with. Example benchmark deploy:
#   TUBE_SAM3_APP=tubewatch-sam3-l4 TUBE_SAM3_GPU=L4 TUBE_SAM3_CONTAINERS=8 TUBE_SAM3_SCALEDOWN=60 \
#     modal deploy -m pipeline.sam3_modal
APP = os.environ.get("TUBE_SAM3_APP", "tubewatch-sam3")
# "vehicle" finds cars, buses and trucks in one pass; "car" alone misses buses and trucks.
PROMPTS = ("vehicle", "person", "bicycle")
SAM3_COMMIT = "0570b3a5be9c4e694f23d85232fb55f4a6f1f7fc"
GPU = os.environ.get("TUBE_SAM3_GPU", "L4")
MAX_CONTAINERS = int(os.environ.get("TUBE_SAM3_CONTAINERS", "8"))
SCALEDOWN_S = int(os.environ.get("TUBE_SAM3_SCALEDOWN", "60"))
MIN_CHUNK_SEC = 6.0
CHUNK_SIDE = 960

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git", "libgl1", "libglib2.0-0")
    .pip_install("torch==2.10.0", "torchvision", index_url="https://download.pytorch.org/whl/cu128")
    .pip_install(f"git+https://github.com/facebookresearch/sam3.git@{SAM3_COMMIT}", "opencv-python-headless",
                 "einops", "pycocotools", "psutil", "scipy", "setuptools<81", "shapely")
    .env({"HF_HOME": "/weights/hf", "HF_HUB_CACHE": "/weights/hf/hub", "TUBE_SAM3_APP": APP, "TUBE_SAM3_GPU": GPU,
          "TUBE_SAM3_CONTAINERS": str(MAX_CONTAINERS), "TUBE_SAM3_SCALEDOWN": str(SCALEDOWN_S)})
    .add_local_python_source("pipeline")
)
app = modal.App(APP, image=image)
weights = modal.Volume.from_name("tubewatch-sam3-weights", create_if_missing=True)


@app.cls(gpu=GPU, volumes={"/weights": weights}, secrets=[modal.Secret.from_name("huggingface")],
         scaledown_window=SCALEDOWN_S, min_containers=0, max_containers=MAX_CONTAINERS, timeout=30 * 60)
class Sam3:
    @modal.enter()
    def load(self):
        import torch
        from sam3.model_builder import build_sam3_video_predictor

        self.predictor = build_sam3_video_predictor(gpus_to_use=[torch.cuda.current_device()])
        weights.commit()

    @modal.method()
    def ping(self) -> str:
        return "ok"

    @modal.method()
    def segment(self, job: dict) -> dict:
        """job: {index, video: mp4 bytes sampled at SAMPLE_FPS, prompts}. Returns {index, timing, objects:
        {prompt: {obj_id: [[i, contour, centroid, mask_area], ...]}}} in the chunk's pixels. The video loads
        once; reset_session switches prompts."""
        from pipeline.contours import mask_contour

        t0 = time.time()
        path = Path(tempfile.mkdtemp()) / "chunk.mp4"
        path.write_bytes(job["video"])
        session = self.predictor.handle_request({"type": "start_session", "resource_path": str(path)})["session_id"]
        timing = {"load_s": round(time.time() - t0, 1)}
        objects = {}
        for k, prompt in enumerate(job["prompts"]):
            t1 = time.time()
            if k:
                self.predictor.handle_request({"type": "reset_session", "session_id": session})
            self.predictor.handle_request(
                {"type": "add_prompt", "session_id": session, "frame_index": 0, "text": prompt})
            objs: dict[str, list] = {}
            for resp in self.predictor.handle_stream_request(
                    {"type": "propagate_in_video", "session_id": session, "propagation_direction": "forward",
                     "evict_cached_frame_outputs": True}):
                out = resp["outputs"]
                for obj_id, mask in zip(out["out_obj_ids"], out["out_binary_masks"], strict=True):
                    mask = mask.cpu().numpy() if hasattr(mask, "cpu") else mask
                    shape = mask_contour(mask)
                    if shape:
                        objs.setdefault(str(int(obj_id)), []).append(
                            [int(resp["frame_index"]), *shape, int(mask.sum())])
            objects[prompt] = objs
            timing[prompt] = round(time.time() - t1, 1)
        self.predictor.handle_request({"type": "close_session", "session_id": session})
        return {"index": job["index"], "timing": timing, "objects": objects}


def remote_cls():
    """The deployed Sam3 class, or raise if it isn't deployed or Modal is unreachable."""
    cls = modal.Cls.from_name(APP, "Sam3")
    cls.hydrate()
    return cls


def available() -> tuple[bool, str]:
    try:
        remote_cls()
        return True, "SAM 3 on Modal"
    except Exception as e:  # noqa: BLE001  any lookup failure means use the fallback
        return False, f"SAM 3 on Modal is unavailable ({type(e).__name__})"


def warm() -> None:
    """Start a container and load the model, without waiting for it."""
    remote_cls()().ping.spawn()


def chunk_video(video: Path, chunk: Chunk) -> bytes:
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "chunk.mp4"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", str(chunk.start), "-i", str(video),
                        "-t", str(chunk.duration), "-vf", f"fps={SAMPLE_FPS},scale={CHUNK_SIDE}:-2", "-an",
                        "-c:v", "libx264", "-crf", "26", "-preset", "veryfast", str(out)], check=True)
        return out.read_bytes()


def sam3_tracks(video: Path, info: dict, on_progress: Callable[[list[dict], int], None],
                parallel: int = MAX_CONTAINERS) -> list[dict]:
    """Raw tracks {source_class, frames} for the whole clip, in `parallel` chunks run side by side. Results
    arrive in order, and after each one the stitched tracks so far go to on_progress(tracks, frames_done)."""
    chunks = plan_chunks(info["duration"], chunk_sec=max(MIN_CHUNK_SEC, info["duration"] / parallel))
    scale = info["width"] / CHUNK_SIDE
    step = round(info["fps"] / SAMPLE_FPS) + 1
    jobs = [{"index": c.index, "video": chunk_video(video, c), "prompts": list(PROMPTS)} for c in chunks]
    tracks: list[dict] = []
    for result in map_with_retry(jobs):
        chunk = chunks[result["index"]]
        print(f"sam3 chunk {chunk.index} ({chunk.duration:.0f}s): {result['timing']}", flush=True)
        tracks = stitch(tracks, to_tracks(result["objects"], chunk, info["fps"], scale))
        done = min(info["frames"], round((chunk.start + chunk.duration) * info["fps"]))
        on_progress([dict(t, frames=densify(t["frames"], step)) for t in tracks], done)
    return [dict(t, frames=densify(t["frames"], step)) for t in tracks]


def map_with_retry(jobs: list[dict], attempts: int = 3):
    """Yield results in chunk order. A dropped connection resubmits only the chunks not yet received."""
    pending = list(jobs)
    for attempt in range(attempts):
        try:
            for result in remote_cls()().segment.map(pending):
                pending.pop(0)
                yield result
            return
        except (OSError, ConnectionError, modal.exception.ConnectionError) as e:
            if attempt == attempts - 1:
                raise
            print(f"sam3: {type(e).__name__}, resubmitting {len(pending)} chunks", flush=True)
