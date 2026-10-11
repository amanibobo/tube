import json

import pytest
from fastapi.testclient import TestClient

from pipeline.build import build_tracks
from pipeline.chunks import frame_record
from pipeline.derive import write_dataset
from pipeline.trackable import resolve
from server.agent import TOOLS, run_agent
from server.main import create_app
from server.plans import plans_for
from server.tools import load_dataset
from tests.test_agent import ScriptedClient
from tests.test_server import FIXTURE, events


@pytest.mark.parametrize("text,expected", [
    ("dog", [("dog", "dog")]),
    ("Dogs", [("dog", "dog")]),
    ("puppies", [("puppy", "dog")]),
    ("Player, ball", [("player", "person"), ("ball", "sports ball")]),
    ("pedestrians, cars", [("pedestrian", "person"), ("car", "car")]),
    ("people", [("person", "person")]),
    ("athlete, runner", [("athlete", "person"), ("runner", "person")]),
    ("sports balls", [("sports ball", "sports ball")]),
    ("dog, dogs ,DOG", [("dog", "dog")]),
])
def test_names_resolve_to_detector_classes_with_the_users_singular_label(text, expected):
    assert [(t["name"], t["detector"]) for t in resolve(text)] == expected


@pytest.mark.parametrize("text", ["dragon", "dog, unicorn", " , "])
def test_unknown_names_are_rejected_with_a_sentence(text):
    with pytest.raises(ValueError, match=r"\."):
        resolve(text)


def square(x, y, s=20):
    return [[x, y], [x + s, y], [x + s, y + s], [x, y + s]]


def still(source, label=None, x=100, frames=60):
    return {"source_class": source, "label": label,
            "frames": [frame_record(f, square(x, 100), [x + 10, 110]) for f in range(frames)]}


def test_named_tracking_keeps_still_animals_and_labels_them():
    dog = still("dog", "dog")
    assert [(t["class"], t["source_class"]) for t in build_tracks([dog], fps=30, track=[{"name": "dog"}])] == [
        ("dog", "dog")]
    assert build_tracks([still("person")], fps=30) == []
    assert build_tracks([still("dog", "dog", frames=10)], fps=30, track=[{"name": "dog"}]) == []


@pytest.fixture
def client(data_copy, monkeypatch):
    monkeypatch.setenv("TUBEWATCH_OFFLINE", "1")
    monkeypatch.setenv("TUBEWATCH_BACKEND", "yolo")
    with TestClient(create_app(data_copy.parent)) as c:
        yield c


def test_trackable_route_and_unknown_track_on_upload(client):
    t = client.get("/api/trackable").json()
    assert t["default"] == ["car", "person", "bicycle"] and "dog" in t["names"] and t["aliases"]["player"] == "person"
    with FIXTURE.open("rb") as f:
        r = client.post("/api/videos", files={"file": ("a.mp4", f, "video/mp4")}, data={"track": "dragons"})
    assert r.status_code == 400 and "dragons" in r.json()["error"]
    assert len(client.get("/api/videos").json()) == 1


def test_tool_schemas_take_any_class():
    for tool in TOOLS:
        for name, prop in tool["input_schema"]["properties"].items():
            if name in ("cls", "class_a", "class_b"):
                assert "enum" not in prop, f"{tool['name']}.{name} still has a fixed class list"


@pytest.fixture
def dogs(tmp_path):
    """Three dogs: 1 and 2 run toward each other and pass 10 px apart at f=50; 3 runs far and alone."""
    def dog(tid, x_at):
        return {"id": tid, "class": "dog", "source_class": "dog", "frames": [
            frame_record(f, square(x_at(f), 100 if tid < 3 else 400, 40), [x_at(f) + 20, 120]) for f in range(100)]}
    tracks = [dog(1, lambda f: 0 + 4 * f), dog(2, lambda f: 450 - 4 * f + (0 if f < 50 else 8 * (f - 50))),
              dog(3, lambda f: 10 * f)]
    for t in tracks:
        t["first_frame"], t["last_frame"] = 0, 99
    root = tmp_path / "dogs"
    write_dataset(root, {"video": {"id": "dogs", "fps": 25, "width": 1280, "height": 720, "frames": 100,
                                   "thumb_stride": 5, "thumb_width": 320}, "tracks": tracks})
    (root / "zones.json").write_text("[]")
    return load_dataset(root)


def test_dog_questions_have_plans_and_the_agent_can_ask_about_dogs(dogs):
    plans = plans_for(dogs)
    assert "every time a person and a car got close" not in plans
    closest = plans["when did two dogs get closest"](dogs)
    assert {s["track_id"] for s in closest["highlight"]["segments"]} == {1, 2}
    assert plans["which dog moved the most"](dogs)["highlight"]["segments"][0]["track_id"] == 3
    client = ScriptedClient([
        [("near", {"class_a": "dog", "class_b": "dog"})],
        [("highlight", {"result_ids": ["r1"], "caption": "c", "summary": "s"})],
    ])
    out = run_agent(dogs, "when did two dogs get closest", client)
    assert out["highlight"]["list"][0]["label"].startswith("dog 1 and dog 2")


@pytest.mark.slow
def test_upload_with_track_labels_tracks_with_the_users_name(client, data_copy):
    with FIXTURE.open("rb") as f:
        meta = client.post("/api/videos", files={"file": ("j.mp4", f, "video/mp4")},
                           data={"track": "Pedestrians"}).json()
    assert meta["track"] == [{"name": "pedestrian", "detector": "person"}]
    assert events(client, meta["id"])[-1] == {"type": "done"}
    tubes = json.loads((data_copy.parent / meta["id"] / "tubes.json").read_text())
    assert tubes["tracks"] and {t["class"] for t in tubes["tracks"]} == {"pedestrian"}
    assert {t["source_class"] for t in tubes["tracks"]} == {"person"}
