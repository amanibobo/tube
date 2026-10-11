import functools
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from pipeline import media
from server.main import create_app
from tests.test_server import events

FIXTURES = Path(__file__).parent / "fixtures"


class Handler(SimpleHTTPRequestHandler):
    """Serves tests/fixtures with single byte ranges, as R2 does; /r/<name> answers 302 to /<name>, like the
    archive API's redirect to R2."""

    def do_GET(self):
        if self.path.startswith("/r/"):
            self.send_response(302)
            self.send_header("Location", self.path[2:])
            self.end_headers()
            return
        path = Path(self.translate_path(self.path))
        if not path.is_file():
            self.send_error(404)
            return
        data = path.read_bytes()
        first, last = 0, len(data) - 1
        if rng := self.headers.get("Range", "").removeprefix("bytes="):
            lo, hi = rng.split("-")
            first, last = int(lo or 0), min(int(hi) if hi else last, last)
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {first}-{last}/{len(data)}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(last - first + 1))
        self.end_headers()
        self.wfile.write(data[first:last + 1])

    def log_message(self, *args):
        pass


@pytest.fixture(scope="module")
def http_base():
    server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(FIXTURES)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()


@pytest.fixture
def client(data_copy, monkeypatch):
    monkeypatch.setenv("TUBEWATCH_OFFLINE", "1")
    monkeypatch.setenv("TUBEWATCH_BACKEND", "yolo")
    with TestClient(create_app(data_copy.parent)) as c:
        yield c


def clip(client, url, start, end, title="Clip"):
    return client.post("/api/videos/clip", json={"url": url, "start_s": start, "end_s": end, "title": title})


@pytest.mark.parametrize("start,end", [(5, 5), (8, 2), (-1, 4), (0, 121)])
def test_bad_ranges_are_rejected_with_a_sentence(client, http_base, start, end):
    r = clip(client, f"{http_base}/junction-5s.mp4", start, end)
    assert r.status_code == 400 and set(r.json()) == {"error"}


@pytest.mark.parametrize("url", [str(FIXTURES / "junction-5s.mp4"), f"file://{FIXTURES / 'junction-5s.mp4'}",
                                 "ftp://example.com/v.mp4", "javascript:alert(1)", "concat:/etc/passwd"])
def test_only_http_links_are_accepted(client, url):
    r = clip(client, url, 0, 3)
    assert r.status_code == 400 and r.json() == {"error": "Only http and https video links can be clipped."}
    assert [m["id"] for m in client.get("/api/videos").json()] == ["synthetic"]


def test_remote_reads_cannot_reach_local_files():
    local = FIXTURES / "junction-5s.mp4"
    assert media.probe(local) is not None
    assert media.probe(f"file://{local}", remote=True) is None


def test_unreadable_or_out_of_range_sources_are_rejected(client, http_base):
    assert clip(client, f"{http_base}/missing.mp4", 0, 3).json() == {"error": "Couldn't read a video at that link."}
    assert clip(client, f"{http_base}/junction-5s.mp4", 30, 40).json() == {
        "error": "The clip starts after the end of the video."}


def test_the_same_moment_returns_the_same_video(client, http_base):
    url = f"{http_base}/r/junction-5s.mp4"
    first = clip(client, url, 1, 3).json()
    again = clip(client, url, 1, 3, title="Other title").json()
    other = clip(client, url, 1, 4).json()
    assert first["source"] == "clip" and first["id"].startswith("clip-")
    assert again["id"] == first["id"] and again["title"] == "Clip"
    assert other["id"] != first["id"]
    assert len([m for m in client.get("/api/videos").json() if m["source"] == "clip"]) == 2


@pytest.mark.slow
def test_a_clip_runs_the_upload_job_through_a_redirect(client, http_base):
    meta = clip(client, f"{http_base}/r/junction-5s.mp4", 1.0, 4.0, title="Junction · 0:01–0:04").json()
    assert meta["status"] == "queued" and meta["duration_s"] == 3.0
    assert events(client, meta["id"])[-1] == {"type": "done"}
    meta = client.get(f"/api/videos/{meta['id']}").json()
    assert meta["status"] == "ready" and meta["source"] == "clip" and meta["title"] == "Junction · 0:01–0:04"
    tubes = client.get(f"/api/videos/{meta['id']}/tubes").json()
    assert 85 <= tubes["video"]["frames"] <= 95 and tubes["tracks"]
    assert client.get(f"/api/videos/{meta['id']}/video.mp4", headers={"Range": "bytes=0-9"}).status_code == 206
