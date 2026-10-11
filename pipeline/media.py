"""Probing, normalizing and thumbnailing video with ffmpeg and OpenCV."""

import json
import shutil
import subprocess
from pathlib import Path

import cv2

MAX_SIDE, MAX_FPS = 1280, 30
MAX_SECONDS = 120
THUMB_STRIDE, THUMB_WIDTH = 5, 320


def probe(path: Path) -> dict | None:
    """{duration, fps, width, height} of the first video stream, or None when there is no video stream."""
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height,avg_frame_rate:format=duration", "-of", "json", str(path)],
                         capture_output=True, text=True)
    info = json.loads(out.stdout or "{}")
    if out.returncode or not info.get("streams"):
        return None
    s = info["streams"][0]
    num, den = (int(x) for x in s.get("avg_frame_rate", "0/1").split("/"))
    return {"duration": float(info.get("format", {}).get("duration") or 0), "fps": num / den if den else 0.0,
            "width": s["width"], "height": s["height"]}


def normalize_video(src: Path, dst: Path, max_seconds: float = MAX_SECONDS) -> None:
    """Re-encode to browser-safe H.264, long side at most MAX_SIDE, at most MAX_FPS, at most max_seconds.
    Detection runs on this copy, so frame indices and pixel coordinates match what the viewer plays."""
    fps = cv2.VideoCapture(str(src)).get(cv2.CAP_PROP_FPS) or MAX_FPS
    vf = f"scale='if(gte(iw,ih),min({MAX_SIDE},iw),-2)':'if(gte(iw,ih),-2,min({MAX_SIDE},ih))'"
    if fps > MAX_FPS + 0.5:
        vf += f",fps={MAX_FPS}"
    tmp = dst.with_name(dst.stem + ".tmp.mp4")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-t", str(max_seconds), "-vf", vf,
                    "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "23",
                    "-movflags", "+faststart", str(tmp)], check=True)
    tmp.replace(dst)


def write_thumbnails(video: Path, frames_dir: Path) -> int:
    """Every THUMB_STRIDE-th frame as a THUMB_WIDTH-wide jpg named by frame index. Returns the frame count."""
    tmp = frames_dir.with_name(frames_dir.name + ".tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    cap = cv2.VideoCapture(str(video))
    n = 0
    while True:
        ok, img = cap.read()
        if not ok:
            break
        if n % THUMB_STRIDE == 0:
            h, w = img.shape[:2]
            thumb = cv2.resize(img, (THUMB_WIDTH, THUMB_WIDTH * h // w), interpolation=cv2.INTER_AREA)
            cv2.imwrite(str(tmp / f"{n:06d}.jpg"), thumb, [cv2.IMWRITE_JPEG_QUALITY, 80])
        n += 1
    shutil.rmtree(frames_dir, ignore_errors=True)
    tmp.replace(frames_dir)
    return n
