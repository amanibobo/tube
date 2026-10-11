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


def test_near_accepts_either_class_order_and_rejects_unpaired_classes(ds, expected):
    assert [pair(h) for h in T.near(ds, "car", "person")] == expected["close_pairs"]
    with pytest.raises(ValueError):
        T.near(ds, "person", "person")


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
    top = T.filter_tracks(ds, cls="car", sort_by_speed=True, top_k=1)
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
