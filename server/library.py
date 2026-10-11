"""The video library: every data/<id>/ with a meta.json or tubes.json is a video."""

import json
import shutil
import threading
import uuid
from pathlib import Path

from pipeline import process
from server.agent import Agent
from server.tools import Dataset, load_dataset

TITLES = {"synthetic": "Synthetic intersection", "pexels-junction": "Junction in Town",
          "astoria-20220723": "Astoria street webcam"}


class Video:
    """One dataset directory. Its Dataset and Agent load on first use and reload after the job rebuilds it."""

    def __init__(self, root: Path):
        self.root = root
        self.id = root.name
        self.lock = threading.RLock()
        self.cancelled = False
        self._ds: Dataset | None = None
        self._agent: Agent | None = None

    @property
    def meta(self) -> dict:
        return process.read_meta(self.root)

    @property
    def ready(self) -> bool:
        return self.meta["status"] == "ready"

    def dataset(self) -> Dataset:
        with self.lock:
            if self._ds is None:
                self._ds = load_dataset(self.root)
            return self._ds

    def agent(self) -> Agent:
        with self.lock:
            if self._agent is None:
                self._agent = Agent(self.dataset())
                self._agent.seed_demo()
            return self._agent

    def invalidate(self) -> None:
        with self.lock:
            self._ds = self._agent = None


def builtin_meta(root: Path) -> dict:
    video = json.loads((root / "tubes.json").read_text())["video"]
    meta = process.new_meta(root.name, TITLES.get(root.name, root.name), "builtin", credit=video.get("credit", ""))
    meta.update(status="ready", progress=1.0, created=(root / "tubes.json").stat().st_mtime,
                duration_s=round(video["frames"] / video["fps"], 2), done=[s[0] for s in process.STAGES])
    return meta


class Library:
    def __init__(self, data_root: Path):
        self.data_root = data_root
        self.videos: dict[str, Video] = {}
        for root in sorted(p for p in data_root.iterdir() if p.is_dir()):
            if not (root / "meta.json").exists() and (root / "tubes.json").exists():
                process.write_meta(root, builtin_meta(root))
            if (root / "meta.json").exists():
                self.videos[root.name] = Video(root)

    def get(self, video_id: str) -> Video | None:
        return self.videos.get(video_id)

    def listing(self) -> list[dict]:
        return sorted((v.meta for v in self.videos.values()), key=lambda m: -m["created"])

    def create_upload(self, filename: str, title: str) -> Video:
        video_id = f"up-{uuid.uuid4().hex[:8]}"
        root = self.data_root / video_id
        root.mkdir()
        suffix = Path(filename).suffix.lower() or ".mp4"
        process.write_meta(root, process.new_meta(video_id, title or Path(filename).stem or video_id, "upload",
                                                  source_file=str(root / f"upload{suffix}")))
        self.videos[video_id] = Video(root)
        return self.videos[video_id]

    def create_clip(self, video_id: str, title: str, url: str, start: float, end: float) -> Video:
        root = self.data_root / video_id
        root.mkdir()
        process.write_meta(root, process.new_meta(video_id, title or video_id, "clip", source_url=url,
                                                  clip_start=start, clip_end=end, duration_s=round(end - start, 2)))
        self.videos[video_id] = Video(root)
        return self.videos[video_id]

    def remove(self, video_id: str) -> None:
        video = self.videos.pop(video_id)
        shutil.rmtree(video.root, ignore_errors=True)
