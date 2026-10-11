"""The PRD's five demo questions, each answered by its documented tool plan with no LLM."""

from collections.abc import Callable

from server import tools as T
from server.tools import Dataset


def close_passes(ds: Dataset) -> dict:
    hits = T.near(ds, "person", "car", moving_only=True)
    return T.highlight(hits, "Person-car close passes",
                       f"{len(hits)} times a person and a moving car came within {ds.params['close_px']:g} px.")


def stopped_in_crosswalk(ds: Dataset) -> dict:
    cars = T.filter_tracks(ds, cls="car")
    hits = T.stopped(ds, [h.spans[0][0] for h in cars], min_sec=1.0, zone_id="crosswalk")
    ids = sorted({h.spans[0][0] for h in hits})
    names = ", ".join(f"car {i}" for i in ids).capitalize() or "No car"
    return T.highlight(hits, "Cars stopped in the crosswalk", f"{names} stopped inside the crosswalk for 1s or more.")


def most_dangerous(ds: Dataset) -> dict:
    hits = T.rank_near_misses(ds, top_k=3)
    return T.highlight(hits, "Top 3 near misses",
                       f"The {len(hits)} closest fast passes between people and cars, ranked by speed over distance.")


def crossings_per_minute(ds: Dataset) -> dict:
    people = T.filter_tracks(ds, cls="person")
    visits = T.in_zone(ds, "crosswalk", [h.spans[0][0] for h in people])
    groups = T.count(ds, visits, "minute")
    parts = ", ".join(g.label for g in groups) or "none"
    return T.highlight(groups, "People crossing per minute", f"People entering the crosswalk per minute: {parts}.")


def fastest_car(ds: Dataset) -> dict:
    hits = T.filter_tracks(ds, cls="car", sort_by_speed=True, top_k=1)
    summary = f"Car {hits[0].spans[0][0]} is the fastest, peaking at {hits[0].score:.0f} px/s." if hits else "No cars."
    return T.highlight(hits, "Fastest car", summary)


DEMO_PLANS: dict[str, Callable[[Dataset], dict]] = {
    "every time a person and a car got close": close_passes,
    "which cars stopped in the crosswalk": stopped_in_crosswalk,
    "which cars stopped inside the crosswalk": stopped_in_crosswalk,
    "top 3 most dangerous moments": most_dangerous,
    "how many people crossed per minute": crossings_per_minute,
    "fastest car in the clip": fastest_car,
}
