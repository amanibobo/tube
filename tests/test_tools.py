from collections import Counter

import pytest

from server import tools as T


def pair(h):
    return [h.extra["a"], h.extra["b"]]


def test_near_finds_exactly_the_scripted_close_passes(ds, expected):
    hits = T.near(ds, "person", "car", 80, moving_only=True)
    assert [pair(h) for h in hits] == expected["close_pairs"]
    for h, nm in zip(hits, expected["near_misses"], strict=True):
        assert h.min_dist == pytest.approx(nm["min_dist"], abs=0.5)
        assert abs(h.f - nm["f"]) <= 15


def test_near_accepts_either_class_order_and_rejects_unknown_classes(ds, expected):
    assert [pair(h) for h in T.near(ds, "car", "person")] == expected["close_pairs"]
    with pytest.raises(ValueError, match="no 'dog' tracks"):
        T.near(ds, "dog", "person")


def brute_closest(cls_a, cls_b):
    """Independent check: every shared frame of every pair, outline gap by plain shapely calls."""
    import json

    import shapely

    from tests.conftest import SYNTH

    tracks = json.loads((SYNTH / "tubes.json").read_text())["tracks"]
    a_tracks = [t for t in tracks if t["class"] == cls_a]
    b_tracks = [t for t in tracks if t["class"] == cls_b]
    best = (float("inf"), None)
    for ta in a_tracks:
        fa = {fr["f"]: fr["contour"] for fr in ta["frames"]}
        for tb in b_tracks:
            if ta["id"] == tb["id"] or (cls_a == cls_b and ta["id"] > tb["id"]):
                continue
            for fr in tb["frames"]:
                if fr["f"] in fa:
                    d = shapely.Polygon(fa[fr["f"]]).distance(shapely.Polygon(fr["contour"]))
                    best = min(best, (d, (ta["id"], tb["id"])))
    return best


@pytest.mark.parametrize("cls_a,cls_b", [("person", "person"), ("bicycle", "person")])
def test_near_on_any_two_classes_matches_brute_force(ds, cls_a, cls_b):
    hits = T.near(ds, cls_a, cls_b, max_dist=200)
    gap, ids = brute_closest(cls_a, cls_b)
    assert hits and hits[0].min_dist == pytest.approx(gap, abs=0.01)
    assert tuple(sorted(hits[0].track_ids)) == tuple(sorted(ids))
    assert all(h.extra["a"] != h.extra["b"] for h in hits)
    assert [h.min_dist for h in hits] == sorted(h.min_dist for h in hits)


def test_filter_tracks_sort_by_distance(ds):
    """Independent check: the raw path length of each person's positions picks the same track."""
    import numpy as np

    path = {tid: float(np.hypot(np.diff(g.cx), np.diff(g.cy)).sum())
            for tid, g in ds.stats.groupby("track_id") if ds.classes[tid] == "person"}
    ranked = T.filter_tracks(ds, cls="person", sort_by="distance")
    assert ranked[0].track_ids == [max(path, key=path.get)]
    assert ranked[0].score == pytest.approx(max(path.values()), rel=0.05)
    assert [h.score for h in ranked] == sorted((h.score for h in ranked), reverse=True)


def test_rank_near_misses_is_empty_without_people_and_vehicles(ds):
    ds.classes = {tid: ("dog" if c == "person" else c) for tid, c in ds.classes.items()}
    ds.roles = {tid: (None if ds.classes[tid] == "dog" else r) for tid, r in ds.roles.items()}
    assert T.rank_near_misses(ds) == []


def test_moving_only_drops_passes_beside_a_stopped_car(ds, expected):
    stationary = expected["close_to_stopped_car"]
    assert stationary in [pair(h) for h in T.near(ds, "person", "car", 80, moving_only=False)]
    assert stationary not in [pair(h) for h in T.near(ds, "person", "car", 80, moving_only=True)]
    assert stationary not in [pair(h) for h in T.rank_near_misses(ds, top_k=50)]


def test_rank_near_misses_puts_scripted_three_on_top_in_order(ds, expected):
    hits = T.rank_near_misses(ds, top_k=10)
    assert [pair(h) for h in hits[:3]] == expected["top3_near_misses"]
    for h, nm in zip(hits, expected["near_misses"], strict=False):
        assert h.score == pytest.approx(nm["score"], rel=0.05)
    assert [h.score for h in hits] == sorted((h.score for h in hits), reverse=True)


def test_rank_near_misses_time_range(ds, expected):
    first = expected["near_misses"][0]
    late = T.rank_near_misses(ds, t_start=first["f"] / ds.fps + 5)
    assert first["person"] not in [h.extra["a"] for h in late]


def test_stopped_in_crosswalk_excludes_car_that_stopped_before_it(ds, expected):
    cars = [h.track_ids[0] for h in T.filter_tracks(ds, cls="car")]
    want = expected["stopped_in_crosswalk"]
    hits = T.stopped(ds, cars, min_sec=1.0, zone_id="crosswalk")
    assert [h.track_ids for h in hits] == [[want["car"]]]
    assert abs(hits[0].spans[0][1] - want["f_start"]) <= 10
    assert abs(hits[0].spans[0][2] - want["f_end"]) <= 10
    anywhere = {h.track_ids[0] for h in T.stopped(ds, cars, min_sec=1.0)}
    assert anywhere == {want["car"], expected["stopped_outside_crosswalk"]["car"]}


def test_filter_tracks_fastest_and_filters(ds, expected):
    top = T.filter_tracks(ds, cls="car", sort_by="peak_speed", top_k=1)
    assert top[0].track_ids == [expected["fastest_car"]["car"]]
    assert top[0].score == pytest.approx(expected["fastest_car"]["speed"], rel=0.02)
    assert len(T.filter_tracks(ds, cls="bicycle")) == 1
    assert {h.track_ids[0] for h in T.filter_tracks(ds, min_speed=600)} == {expected["fastest_car"]["car"]}
    assert all(h.score <= 100 for h in T.filter_tracks(ds, cls="person", max_speed=100))


def test_in_zone_finds_every_crossing_person(ds, expected):
    people = [h.track_ids[0] for h in T.filter_tracks(ds, cls="person")]
    hits = T.in_zone(ds, "crosswalk", people)
    assert sorted(h.track_ids[0] for h in hits) == expected["crossing_people"]


def test_count_by_minute(ds, expected):
    people = [h.track_ids[0] for h in T.filter_tracks(ds, cls="person")]
    groups = T.count(ds, T.in_zone(ds, "crosswalk", people), "minute")
    assert {g.label.split(":")[0]: int(g.score) for g in groups} == {
        f"minute {m}": n for m, n in expected["crossings_per_minute"].items()}
    by_class = T.count(ds, T.filter_tracks(ds), "class")
    assert {g.label.split(":")[0]: int(g.score) for g in by_class} == Counter(ds.classes.values())


def test_zone_queries_follow_zones_added_at_runtime(ds, expected):
    yielder = expected["stopped_outside_crosswalk"]["car"]
    with pytest.raises(ValueError):
        T.stopped(ds, min_sec=1.0, zone_id="stop line")
    ds.zones.append({"id": "z9", "name": "Stop line", "polygon": [[780, 260], [1020, 260], [1020, 400], [780, 400]]})
    assert [h.track_ids[0] for h in T.stopped(ds, min_sec=1.0, zone_id="stop line")] == [yielder]
    assert yielder in [h.track_ids[0] for h in T.in_zone(ds, "z9")]
    ds.zones[:] = [z for z in ds.zones if z["id"] != "crosswalk"]
    with pytest.raises(ValueError):
        T.in_zone(ds, "crosswalk")


def test_highlight_payload(ds):
    hits = T.rank_near_misses(ds, top_k=2)
    out = T.highlight(hits, "cap", "sum")
    assert out["summary"] == "sum" and out["highlight"]["caption"] == "cap"
    assert len(out["highlight"]["list"]) == 2
    assert {s["track_id"] for s in out["highlight"]["segments"]} == {t for h in hits for t in h.track_ids}
    seg = out["highlight"]["segments"][0]
    assert set(seg) == {"track_id", "f_start", "f_end", "color"} and seg["f_start"] <= seg["f_end"]
