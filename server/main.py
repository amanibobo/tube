"""FastAPI server for the video library (docs/api.md v2). Run: uvicorn server.main:app --port 8000

TUBEWATCH_DATA_ROOT picks the library directory (default: the repo's data/).
"""

import json
import os
import shutil
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from pipeline import media, process
from server.jobs import EventHub, Jobs
from server.library import Library, Video
from server.tools import rank_near_misses

VIDEO_SUFFIXES = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".ogv", ".mpg", ".mpeg"}
DEFAULT_ROOT = Path(__file__).resolve().parents[1] / "data"


class QueryIn(BaseModel):
    text: str = Field(min_length=1)


class ApiError(Exception):
    def __init__(self, status: int, sentence: str):
        self.status, self.sentence = status, sentence


def error(status: int, sentence: str) -> JSONResponse:
    return JSONResponse({"error": sentence}, status_code=status)


def warm_gpu() -> None:
    try:
        from pipeline import sam3_modal

        sam3_modal.warm()
    except Exception:  # noqa: BLE001, S110  warming is best effort; a cold start just takes longer
        pass


def create_app(data_root: Path) -> FastAPI:
    library = Library(data_root)
    hub = EventHub()
    jobs = Jobs(library, hub)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        jobs.resume()
        yield

    app = FastAPI(title="tubewatch", lifespan=lifespan)
    app.add_exception_handler(ApiError, lambda _req, e: error(e.status, e.sentence))

    def find(video_id: str) -> Video:
        video = library.get(video_id)
        if video is None:
            raise ApiError(404, "No video with that id.")
        return video

    @app.get("/api/videos")
    def list_videos():
        return library.listing()

    @app.post("/api/videos")
    def upload(file: Annotated[UploadFile, File()], title: Annotated[str, Form()] = ""):
        suffix = Path(file.filename or "").suffix.lower()
        if not (file.content_type or "").startswith("video/") and suffix not in VIDEO_SUFFIXES:
            return error(400, "That file isn't a video.")
        video = library.create_upload(file.filename or "upload.mp4", title)
        dest = Path(video.meta["source_file"])
        tmp = dest.with_suffix(dest.suffix + ".part")
        with tmp.open("wb") as out:
            shutil.copyfileobj(file.file, out, 1 << 20)
        tmp.replace(dest)
        info = media.probe(dest)
        if info is None:
            library.remove(video.id)
            return error(400, "That file isn't a video this app can read.")
        fields = {"duration_s": round(min(info["duration"], media.MAX_SECONDS), 2)}
        if info["duration"] > media.MAX_SECONDS:
            m, s = divmod(round(info["duration"]), 60)
            fields["notice"] = f"This clip is {m}:{s:02d} long, so only the first 2 minutes are used."
        meta = process.update_meta(video.root, **fields)
        jobs.submit(video)
        return meta

    @app.get("/api/videos/{video_id}")
    def get_video(video_id: str):
        video = find(video_id)
        return video.meta

    @app.delete("/api/videos/{video_id}")
    def delete_video(video_id: str):
        video = find(video_id)
        if video.meta["source"] == "builtin":
            return error(403, "Built-in videos can't be deleted.")
        if video.id in jobs.active:
            video.cancelled = True
            library.videos.pop(video.id)
        else:
            library.remove(video.id)
        return {"ok": True}

    @app.get("/api/videos/{video_id}/events")
    async def events(video_id: str):
        video = find(video_id)

        async def stream():
            sub = hub.subscribe(video_id)
            try:
                meta = video.meta
                if meta["status"] == "ready":
                    yield sse({"type": "done"})
                    return
                if meta["status"] == "failed":
                    yield sse({"type": "error", "message": meta["error"]})
                    return
                yield sse({"type": "status", "status": meta["status"], "stage": meta["stage"],
                           "progress": meta["progress"], "message": meta.get("message", "")})
                while True:
                    event = await sub[1].get()
                    yield sse(event)
                    if event["type"] in ("done", "error"):
                        return
            finally:
                hub.unsubscribe(video_id, sub)

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.get("/api/videos/{video_id}/tubes")
    def tubes(video_id: str):
        video = find(video_id)
        path = video.root / "tubes.json"
        return FileResponse(path, media_type="application/json") if path.exists() else error(404, "No tracks yet.")

    @app.get("/api/videos/{video_id}/video.mp4")
    def video_file(video_id: str):
        video = find(video_id)
        path = video.root / "video.mp4"
        return FileResponse(path, media_type="video/mp4") if path.exists() else error(404, "Still preparing.")

    @app.get("/api/videos/{video_id}/frames/{f}.jpg")
    def frame(video_id: str, f: int):
        video = find(video_id)
        thumbs = sorted(int(p.stem) for p in (video.root / "frames").glob("*.jpg"))
        if not thumbs:
            return error(404, "Still preparing.")
        stride = thumbs[1] - thumbs[0] if len(thumbs) > 1 else 1
        nearest = min(max(0, round(f / stride) * stride), thumbs[-1])
        return FileResponse(video.root / "frames" / f"{nearest:06d}.jpg", media_type="image/jpeg")

    @app.get("/api/videos/{video_id}/near-misses")
    def near_misses(video_id: str, top_k: int = 10):
        video = find(video_id)
        if not video.ready:
            raise ApiError(409, "This video is still processing.")
        return {"list": [{"label": h.label, "f": h.f, "score": round(h.score, 2), "a": h.extra["a"],
                          "b": h.extra["b"], "min_dist": round(h.min_dist, 1)}
                         for h in rank_near_misses(video.dataset(), top_k=top_k)]}

    @app.post("/api/videos/{video_id}/query")
    def query(video_id: str, body: QueryIn):
        video = find(video_id)
        if not video.ready:
            return {"error": "This video is still processing. Ask again when it's ready."}
        return video.agent().answer(body.text)

    @app.post("/api/warm")
    def warm():
        threading.Thread(target=warm_gpu, daemon=True).start()
        return {"ok": True}

    return app


def sse(event: dict) -> str:
    return f"data: {json.dumps(event)}\n\n"


app = create_app(Path(os.environ.get("TUBEWATCH_DATA_ROOT", DEFAULT_ROOT)))
