import json
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from pipeline import process
from server.main import create_app

FIXTURE = Path(__file__).parent / "fixtures" / "junction-5s.mp4"
STOP_Q = {"text": "Which cars stopped inside the crosswalk?"}
STAGES = [s[0] for s in process.STAGES]


@pytest.fixture
def root(data_copy):
    return data_copy.parent


@pytest.fixture
def client(root, monkeypatch):
    monkeypatch.setenv("TUBEWATCH_OFFLINE", "1")
    monkeypatch.setenv("TUBEWATCH_BACKEND", "yolo")
    with TestClient(create_app(root)) as c:
        yield c


def events(client, video_id) -> list[dict]:
    with client.stream("GET", f"/api/videos/{video_id}/events") as r:
        assert r.headers["content-type"].startswith("text/event-stream")
        return [json.loads(line[6:]) for line in r.iter_lines() if line.startswith("data: ")]


def test_library_lists_builtins_and_scopes_every_route(client, expected):
    [meta] = client.get("/api/videos").json()
    assert meta["id"] == "synthetic" and meta["status"] == "ready" and meta["source"] == "builtin"
    base = "/api/videos/synthetic"
    assert client.get(base).json()["id"] == "synthetic"
    assert client.get(f"{base}/tubes").json()["video"]["id"] == "synthetic"
    part = client.get(f"{base}/video.mp4", headers={"Range": "bytes=0-99"})
    assert part.status_code == 206 and len(part.content) == 100
    assert client.get(f"{base}/frames/1381.jpg").content[:2] == b"\xff\xd8"
    items = client.get(f"{base}/near-misses", params={"top_k": 3}).json()["list"]
    assert [[i["a"], i["b"]] for i in items] == expected["top3_near_misses"]
    assert client.post(f"{base}/query", json={"text": "fastest car in the clip"}).json()["cached"] is True
    assert events(client, "synthetic") == [{"type": "done"}]
    assert client.get("/api/videos/nope/tubes").status_code == 404
    assert client.delete(base).status_code == 403
    assert client.get("/api/tubes").status_code == 404


def test_zone_questions_use_the_preset_crosswalk(client, root, expected):
    base = "/api/videos/synthetic"
    car = expected["stopped_in_crosswalk"]["car"]
    assert client.post(f"{base}/query", json=STOP_Q).json()["highlight"]["segments"][0]["track_id"] == car
    assert client.get(f"{base}/zones").status_code in (404, 405)


def test_rejects_files_that_are_not_video(client):
    r = client.post("/api/videos", files={"file": ("notes.txt", b"hello", "text/plain")})
    assert r.status_code == 400 and set(r.json()) == {"error"}
    r = client.post("/api/videos", files={"file": ("fake.mp4", b"not a video", "video/mp4")})
    assert r.status_code == 400 and len(client.get("/api/videos").json()) == 1


@pytest.mark.slow
def test_upload_runs_every_stage_streams_events_and_resumes(client, root, monkeypatch):
    with FIXTURE.open("rb") as f:
        meta = client.post("/api/videos", files={"file": ("junction.mp4", f, "video/mp4")},
                           data={"title": "Junction"}).json()
    assert meta["status"] == "queued" and meta["source"] == "upload" and meta["title"] == "Junction"
    vid = meta["id"]
    stream = events(client, vid)

    assert stream[-1] == {"type": "done"}
    stages = [e["stage"] for e in stream if e["type"] == "status" and e["stage"]]
    assert stages == sorted(stages, key=STAGES.index) and {"building", "indexing"} <= set(stages)
    progress = [e["progress"] for e in stream if e["type"] == "status"]
    assert progress == sorted(progress)
    tubes_events = [i for i, e in enumerate(stream) if e["type"] == "tubes"]
    assert tubes_events and tubes_events[-1] < len(stream) - 1
    # the empty partial cube lands as soon as the video is prepared, before any tracks
    assert stream[tubes_events[0]]["tracks"] == 0

    meta = client.get(f"/api/videos/{vid}").json()
    assert meta["status"] == "ready" and meta["done"] == STAGES and meta["backend"] == "yolo"
    assert not (root / vid / "upload.mp4").exists()
    tubes = client.get(f"/api/videos/{vid}/tubes").json()
    assert tubes["video"]["frames"] == 150 and "partial" not in tubes["video"] and tubes["tracks"]
    assert client.get(f"/api/videos/{vid}/near-misses").status_code == 200
    assert "highlight" in client.post(f"/api/videos/{vid}/query", json={"text": "Fastest car in the clip"}).json()

    process.update_meta(root / vid, status="processing", done=STAGES[:2])
    (root / vid / "tubes.json").unlink()
    with TestClient(create_app(root)) as restarted:
        stream = events(restarted, vid)
        assert stream[-1] == {"type": "done"}
        assert "normalizing" not in [e.get("stage") for e in stream]
        assert restarted.get(f"/api/videos/{vid}/tubes").json()["tracks"]

    assert client.delete(f"/api/videos/{vid}").json() == {"ok": True}
    assert not (root / vid).exists()


def test_interrupted_upload_without_its_file_fails_with_a_sentence(root, monkeypatch):
    monkeypatch.setenv("TUBEWATCH_BACKEND", "yolo")
    (root / "up-lost").mkdir()
    process.write_meta(root / "up-lost", {**process.new_meta("up-lost", "Lost", "upload",
                                                             source_file=str(root / "up-lost" / "upload.mp4")),
                                          "status": "processing"})
    with TestClient(create_app(root)) as c:
        assert events(c, "up-lost")[-1] == {
            "type": "error", "message": "The uploaded file is missing. Please upload the video again."}
        meta = c.get("/api/videos/up-lost").json()
        assert meta["status"] == "failed" and meta["error"].startswith("The uploaded file is missing")


def test_builtin_meta_is_written_for_a_bare_dataset(tmp_path, data_copy):
    bare = tmp_path / "bare"
    shutil.copytree(data_copy, bare)
    (bare / "meta.json").unlink()
    with TestClient(create_app(tmp_path)) as c:
        ids = {m["id"]: m for m in c.get("/api/videos").json()}
        assert ids["bare"]["status"] == "ready" and ids["bare"]["source"] == "builtin"
