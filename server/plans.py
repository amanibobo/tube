"""Cached demo answers, each from a documented tool plan with no LLM: the PRD's five traffic questions, plus
three questions per class for any clip ("fastest dog in the clip", "which dog moved the most", "when did two
dogs get closest")."""

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
    hits = T.filter_tracks(ds, cls="car", sort_by="peak_speed", top_k=1)
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


def plural(cls: str) -> str:
    if cls == "person":
        return "people"
    return cls + ("es" if cls.endswith(("s", "sh", "ch", "x")) else "s")


def mmss(ds: Dataset, f: int) -> str:
    m, sec = divmod(round(f / ds.fps), 60)
    return f"{m}:{sec:02d}"


def fastest(cls: str) -> Callable[[Dataset], dict]:
    def plan(ds: Dataset) -> dict:
        hits = T.filter_tracks(ds, cls=cls, sort_by="peak_speed", top_k=1)
        tid = hits[0].track_ids[0]
        return T.highlight(hits, f"Fastest {cls}",
                           f"{cls.capitalize()} {tid} is the fastest, peaking at {hits[0].score:.0f} px/s.")
    return plan


def moved_most(cls: str) -> Callable[[Dataset], dict]:
    def plan(ds: Dataset) -> dict:
        hits = T.filter_tracks(ds, cls=cls, sort_by="distance", top_k=1)
        tid = hits[0].track_ids[0]
        return T.highlight(hits, f"{cls.capitalize()} that moved the most",
                           f"{cls.capitalize()} {tid} moved the most, about {hits[0].score:.0f} px in all.")
    return plan


def closest_pair(cls: str) -> Callable[[Dataset], dict]:
    def plan(ds: Dataset) -> dict:
        hits = T.near(ds, cls, cls)[:1]
        if not hits:
            return T.highlight([], f"Closest two {plural(cls)}",
                               f"No two {plural(cls)} came within {ds.params['close_px']:g} px of each other.")
        a, b = hits[0].extra["a"], hits[0].extra["b"]
        return T.highlight(hits, f"Closest two {plural(cls)}",
                           f"{cls.capitalize()} {a} and {cls} {b} were closest at {mmss(ds, hits[0].f)}, "
                           f"{hits[0].min_dist:.0f} px apart.")
    return plan


def plans_for(ds: Dataset) -> dict[str, Callable[[Dataset], dict]]:
    """The demo questions this clip can answer: the traffic five when it has cars and people, then three per
    class, keyed by normalized question text."""
    counts: dict[str, int] = {}
    for c in ds.classes.values():
        counts[c] = counts.get(c, 0) + 1
    plans = dict(DEMO_PLANS) if {"car", "person"} <= set(counts) else {}
    for cls, n in sorted(counts.items()):
        plans.setdefault(f"fastest {cls} in the clip", fastest(cls))
        plans[f"which {cls} moved the most"] = moved_most(cls)
        if n >= 2:
            plans[f"when did two {plural(cls)} get closest"] = closest_pair(cls)
    return plans
