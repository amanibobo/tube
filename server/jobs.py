"""Background processing of uploads, one at a time, with progress pushed to SSE subscribers."""

import asyncio
import logging
import queue
import shutil
import threading
import traceback

from pipeline import process
from server.library import Library, Video

log = logging.getLogger("tubewatch.jobs")
PROGRESS_STEP = 0.02


class EventHub:
    """Per-video subscribers, each an asyncio queue on its own event loop; publish is safe from any thread."""

    def __init__(self):
        self.lock = threading.Lock()
        self.subs: dict[str, set[tuple[asyncio.AbstractEventLoop, asyncio.Queue]]] = {}

    def subscribe(self, video_id: str) -> tuple[asyncio.AbstractEventLoop, asyncio.Queue]:
        sub = (asyncio.get_running_loop(), asyncio.Queue())
        with self.lock:
            self.subs.setdefault(video_id, set()).add(sub)
        return sub

    def unsubscribe(self, video_id: str, sub) -> None:
        with self.lock:
            self.subs.get(video_id, set()).discard(sub)

    def publish(self, video_id: str, event: dict) -> None:
        with self.lock:
            subs = list(self.subs.get(video_id, ()))
        for loop, q in subs:
            loop.call_soon_threadsafe(q.put_nowait, event)


class Cancelled(Exception):
    pass


class JobReporter:
    """Turns stage progress into meta.json updates and status/tubes events."""

    def __init__(self, video: Video, hub: EventHub):
        self.video, self.hub = video, hub
        self.start, self.width, self.last, self.stage_name, self.message = 0.0, 0.0, -1.0, None, ""

    def _check(self) -> None:
        if self.video.cancelled:
            raise Cancelled

    def _emit(self, progress: float) -> None:
        process.update_meta(self.video.root, progress=round(progress, 3), message=self.message)
        self.last = progress
        self.hub.publish(self.video.id, {"type": "status", "status": "processing", "stage": self.stage_name,
                                         "progress": round(progress, 3), "message": self.message})

    def stage(self, name: str, message: str) -> None:
        self._check()
        self.start, self.width = process.stage_span(name)
        self.stage_name, self.message = name, message
        self._emit(self.start)

    def progress(self, fraction: float) -> None:
        self._check()
        p = self.start + self.width * min(max(fraction, 0.0), 1.0)
        if p - self.last >= PROGRESS_STEP:
            self._emit(p)

    def tubes(self, frames_done: int, n_tracks: int) -> None:
        self.hub.publish(self.video.id, {"type": "tubes", "frames_done": frames_done, "tracks": n_tracks})


class Jobs:
    def __init__(self, library: Library, hub: EventHub):
        self.library, self.hub = library, hub
        self.queue: queue.Queue[Video] = queue.Queue()
        self.active: set[str] = set()
        threading.Thread(target=self._worker, daemon=True, name="tubewatch-jobs").start()

    def submit(self, video: Video) -> None:
        self.active.add(video.id)
        self.queue.put(video)

    def resume(self) -> None:
        """Re-queue jobs a restart interrupted; finished stages are skipped."""
        for video in self.library.videos.values():
            if video.meta["status"] in ("queued", "processing"):
                self.submit(video)

    def _worker(self) -> None:
        while True:
            video = self.queue.get()
            try:
                self._run(video)
            finally:
                self.active.discard(video.id)

    def _run(self, video: Video) -> None:
        try:
            if video.cancelled:
                raise Cancelled
            process.run(video.root, JobReporter(video, self.hub))
            video.invalidate()
            self.hub.publish(video.id, {"type": "done"})
        except Cancelled:
            shutil.rmtree(video.root, ignore_errors=True)
        except process.JobFailed as e:
            self._fail(video, str(e))
        except Exception as e:  # noqa: BLE001  any crash becomes a plain sentence for the viewer
            log.error("job %s failed\n%s", video.id, traceback.format_exc())
            self._fail(video, f"Processing failed ({type(e).__name__}). Try uploading the video again.")

    def _fail(self, video: Video, sentence: str) -> None:
        process.update_meta(video.root, status="failed", error=sentence)
        self.hub.publish(video.id, {"type": "error", "message": sentence})
