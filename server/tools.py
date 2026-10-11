"""The geometry tools, as pure functions over an in-memory Dataset. Classes are whatever the video was tracked
for ("car", "dog", "player"); traffic semantics come from each track's role (see pipeline.derive.ROLES).

Every tool returns a list of Hit. A Hit is one answer row: a label, a key frame to jump to, a score,
and the track spans to light up. count and highlight consume Hits, so any tool's output can feed them.
"""

import json
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd
import shapely

from pipeline.derive import DEFAULT_PARAMS, role

RUN_GAP = 5
HIGHLIGHT_RED = "#ff3b30"


@dataclass
class Dataset:
    root: Path
    video: dict
    classes: dict[int, str]
    roles: dict[int, str | None]
    stats: pd.DataFrame
    pairs: pd.DataFrame
    outlines: pd.DataFrame
    zones: list[dict]

    @property
    def fps(self) -> float:
        return self.video["fps"]

    @property
    def params(self) -> dict:
        """close_px, moving_speed (px/s) and stop_speed (px/s) for this clip's scale."""
        return {**DEFAULT_PARAMS, **self.video.get("params", {})}


def load_dataset(root: Path) -> Dataset:
    tubes = json.loads((root / "tubes.json").read_text())
    zones_path = root / "zones.json"
    outlines = pd.DataFrame([(t["id"], fr["f"], *fr["bbox"], fr["contour"]) for t in tubes["tracks"]
                             for fr in t["frames"]], columns=["track_id", "f", "x0", "y0", "x1", "y1", "contour"])
    return Dataset(
        root=root,
        video=tubes["video"],
        classes={t["id"]: t["class"] for t in tubes["tracks"]},
        roles={t["id"]: role(t) for t in tubes["tracks"]},
        stats=pd.read_parquet(root / "stats.parquet"),
        pairs=pd.read_parquet(root / "pairs.parquet"),
        outlines=outlines,
        zones=json.loads(zones_path.read_text()) if zones_path.exists() else [],
    )


def class_ids(ds: Dataset, cls: str) -> list[int]:
    """Track ids of a class. A class the clip doesn't have raises a sentence that lists the ones it has."""
    ids = [tid for tid, c in ds.classes.items() if c == cls]
    if not ids:
        have = ", ".join(sorted(set(ds.classes.values()))) or "none"
        raise ValueError(f"This video has no {cls!r} tracks. Its classes are: {have}.")
    return ids


def class_role(ds: Dataset, cls: str) -> str | None:
    return ds.roles[class_ids(ds, cls)[0]]


@dataclass
class Hit:
    label: str
    f: int
    score: float
    spans: list[tuple[int, int, int]]
    min_dist: float | None = None
    extra: dict = field(default_factory=dict)

    @property
    def track_ids(self) -> list[int]:
        return sorted({s[0] for s in self.spans})


def find_zone(ds: Dataset, zone: str) -> dict:
    for z in ds.zones:
        if zone in (z["id"], z["name"]) or zone.lower() == z["name"].lower():
            return z
    names = ", ".join(z["name"] for z in ds.zones) or "none"
    raise ValueError(f"No zone named {zone!r}. This video has these zones: {names}.")


def _runs(frames: np.ndarray, mask: np.ndarray, gap: int = RUN_GAP) -> list[tuple[int, int]]:
    """Contiguous (f_start, f_end) runs of frames where mask holds, bridging gaps up to `gap` frames."""
    hits = frames[mask]
    if len(hits) == 0:
        return []
    breaks = np.flatnonzero(np.diff(hits) > gap)
    starts = np.r_[hits[0], hits[breaks + 1]]
    ends = np.r_[hits[breaks], hits[-1]]
    return list(zip(starts.tolist(), ends.tolist(), strict=True))


def _rows(ds: Dataset, track_ids: Iterable[int] | None) -> pd.DataFrame:
    s = ds.stats
    return s if track_ids is None else s[s.track_id.isin(list(track_ids))]


def _in_time(f: int, ds: Dataset, t_start: float | None, t_end: float | None) -> bool:
    t = f / ds.fps
    return (t_start is None or t >= t_start) and (t_end is None or t <= t_end)


def filter_tracks(ds: Dataset, cls: str | None = None, min_speed: float | None = None,
                  max_speed: float | None = None, min_duration_sec: float | None = None,
                  t_start: float | None = None, t_end: float | None = None,
                  sort_by: str | None = None, top_k: int | None = None) -> list[Hit]:
    """Tracks by class, peak speed (px/s), duration, and overlap with a time range.
    sort_by "peak_speed" or "distance" (total px traveled) orders the result, highest first, and makes that
    the score; otherwise the score is the peak speed."""
    if sort_by not in (None, "peak_speed", "distance"):
        raise ValueError("sort_by must be 'peak_speed' or 'distance'")
    if cls is not None:
        class_ids(ds, cls)
    hits = []
    for tid, g in ds.stats.groupby("track_id"):
        if cls is not None and ds.classes[tid] != cls:
            continue
        peak = g.speed.max()
        traveled = float(g.speed.sum() / ds.fps)
        f0, f1 = int(g.f.iloc[0]), int(g.f.iloc[-1])
        if min_speed is not None and peak < min_speed or max_speed is not None and peak > max_speed:
            continue
        if min_duration_sec is not None and (f1 - f0 + 1) / ds.fps < min_duration_sec:
            continue
        if t_start is not None and f1 / ds.fps < t_start or t_end is not None and f0 / ds.fps > t_end:
            continue
        f_peak = int(g.f.iloc[int(np.argmax(g.speed.to_numpy()))])
        if sort_by == "distance":
            hits.append(Hit(f"{ds.classes[tid]} {tid}, moved {traveled:.0f} px", f_peak, traveled, [(tid, f0, f1)]))
        else:
            hits.append(Hit(f"{ds.classes[tid]} {tid}, peak {peak:.0f} px/s", f_peak, float(peak), [(tid, f0, f1)]))
    if sort_by:
        hits.sort(key=lambda h: -h.score)
    return hits[:top_k] if top_k else hits


def near(ds: Dataset, class_a: str = "person", class_b: str = "car", max_dist: float | None = None,
         moving_only: bool | None = None, t_start: float | None = None, t_end: float | None = None) -> list[Hit]:
    """Episodes where a track of class_a and a track of class_b (the same class works too) come within max_dist
    px, default the clip's close_px, which scales with object size.

    A person or two-wheeler against a vehicle uses the traffic geometry (feet to ground line, from the pairs
    table); moving_only defaults to on, and the score is the near-miss score, highest first. Any other pair uses
    the gap between outlines; moving_only (either track moving) defaults to off, the score is the gap in px, and
    the closest come first."""
    roles = {class_role(ds, class_a), class_role(ds, class_b)}
    if roles == {"vulnerable", "vehicle"}:
        if class_role(ds, class_a) == "vehicle":
            class_a, class_b = class_b, class_a
        return _traffic_near(ds, class_a, class_b, max_dist, moving_only is not False, t_start, t_end)
    return _outline_near(ds, class_a, class_b, max_dist, bool(moving_only), t_start, t_end)


def _episodes(ds: Dataset, p: pd.DataFrame, t_start, t_end):
    """(a, b, f0, f1, closest row) for each run of frames a pair spends within range."""
    for (a, b), g in p.groupby(["a", "b"]):
        frames = g.f.to_numpy()
        for f0, f1 in _runs(frames, np.ones(len(frames), bool), gap=15):
            ep = g[(g.f >= f0) & (g.f <= f1)]
            closest = ep[ep.dist <= ep.dist.min() + 0.5]
            best = closest.iloc[len(closest) // 2]
            if _in_time(int(best.f), ds, t_start, t_end):
                yield int(a), int(b), f0, f1, best


def _traffic_near(ds, class_a, class_b, max_dist, moving_only, t_start, t_end) -> list[Hit]:
    p = ds.pairs[ds.pairs.dist <= (max_dist or ds.params["close_px"])]
    p = p[p.a.map(ds.classes).eq(class_a) & p.b.map(ds.classes).eq(class_b)]
    speed = ds.stats.set_index(["track_id", "f"]).speed
    p = p.assign(v=speed.reindex(pd.MultiIndex.from_arrays([p.b, p.f])).to_numpy())
    if moving_only:
        p = p[p.v > ds.params["moving_speed"]]
    hits = []
    for a, b, f0, f1, best in _episodes(ds, p, t_start, t_end):
        score = float(best.v) / max(float(best.dist), 1.0)
        label = f"{ds.classes[a]} {a} and {ds.classes[b]} {b}, {best.dist:.0f} px at {best.v:.0f} px/s"
        hits.append(Hit(label, int(best.f), score, [(a, f0, f1), (b, f0, f1)], float(best.dist), {"a": a, "b": b}))
    return sorted(hits, key=lambda h: -h.score)


def _outline_near(ds, class_a, class_b, max_dist, moving_only, t_start, t_end) -> list[Hit]:
    limit = max_dist or ds.params["close_px"]
    o = ds.outlines
    m = o[o.track_id.isin(class_ids(ds, class_a))].merge(
        o[o.track_id.isin(class_ids(ds, class_b))], on="f", suffixes=("_a", "_b"))
    m = m[m.track_id_a < m.track_id_b] if class_a == class_b else m[m.track_id_a != m.track_id_b]
    gap_x = np.maximum(0, np.maximum(m.x0_a - m.x1_b, m.x0_b - m.x1_a))
    gap_y = np.maximum(0, np.maximum(m.y0_a - m.y1_b, m.y0_b - m.y1_a))
    m = m[np.hypot(gap_x, gap_y) <= limit]
    if m.empty:
        return []
    poly = lambda col: shapely.make_valid(np.array([shapely.Polygon(c) for c in m[col]], dtype=object))  # noqa: E731
    p = pd.DataFrame({"a": m.track_id_a.to_numpy(), "b": m.track_id_b.to_numpy(), "f": m.f.to_numpy(),
                      "dist": shapely.distance(poly("contour_a"), poly("contour_b"))})
    p = p[p.dist <= limit]
    if moving_only:
        speed = ds.stats.set_index(["track_id", "f"]).speed
        va = speed.reindex(pd.MultiIndex.from_arrays([p.a, p.f])).to_numpy()
        vb = speed.reindex(pd.MultiIndex.from_arrays([p.b, p.f])).to_numpy()
        p = p[np.fmax(va, vb) > ds.params["moving_speed"]]
    hits = [Hit(f"{ds.classes[a]} {a} and {ds.classes[b]} {b}, {best.dist:.0f} px apart", int(best.f),
                float(best.dist), [(a, f0, f1), (b, f0, f1)], float(best.dist), {"a": a, "b": b})
            for a, b, f0, f1, best in _episodes(ds, p, t_start, t_end)]
    return sorted(hits, key=lambda h: h.min_dist)


def rank_near_misses(ds: Dataset, top_k: int = 10, t_start: float | None = None,
                     t_end: float | None = None) -> list[Hit]:
    """PRD v1, traffic only: per person/two-wheeler and vehicle pair, the closest moving pass under close_px,
    scored vehicle speed / min distance, highest first. Empty for a clip without people and vehicles."""
    by_role: dict[str | None, set[str]] = {}
    for tid, cls in ds.classes.items():
        by_role.setdefault(ds.roles[tid], set()).add(cls)
    best: dict[tuple[int, int], Hit] = {}
    pairs = [(a, b) for a in sorted(by_role.get("vulnerable", ())) for b in sorted(by_role.get("vehicle", ()))]
    for a_cls, b_cls in pairs:
        for h in _traffic_near(ds, a_cls, b_cls, None, True, t_start, t_end):
            key = (h.extra["a"], h.extra["b"])
            if key not in best or h.min_dist < best[key].min_dist:
                best[key] = h
    return sorted(best.values(), key=lambda h: -h.score)[:top_k]


def in_zone(ds: Dataset, zone_id: str, track_ids: Iterable[int] | None = None,
            min_dwell_sec: float = 0.0) -> list[Hit]:
    """Visits whose centroid is inside the zone, as entry/exit frames. Score = dwell seconds."""
    zone = find_zone(ds, zone_id)
    poly = shapely.Polygon(zone["polygon"])
    s = _rows(ds, track_ids)
    inside = shapely.contains_xy(poly, s.cx.to_numpy(), s.cy.to_numpy())
    hits = []
    for tid, g in s.assign(inside=inside).groupby("track_id"):
        for f0, f1 in _runs(g.f.to_numpy(), g.inside.to_numpy()):
            dwell = (f1 - f0 + 1) / ds.fps
            if dwell >= min_dwell_sec:
                hits.append(Hit(f"{ds.classes[tid]} {tid} in {zone['name']} {dwell:.1f}s", f0, dwell,
                                [(tid, f0, f1)]))
    return sorted(hits, key=lambda h: h.f)


def stopped(ds: Dataset, track_ids: Iterable[int] | None = None, min_sec: float = 1.0,
            zone_id: str | None = None) -> list[Hit]:
    """Intervals where a track's speed stays under the clip's stop_speed for min_sec, optionally in a zone."""
    s = _rows(ds, track_ids)
    mask = s.speed.to_numpy() < ds.params["stop_speed"]
    where = ""
    if zone_id is not None:
        zone = find_zone(ds, zone_id)
        mask &= shapely.contains_xy(shapely.Polygon(zone["polygon"]), s.cx.to_numpy(), s.cy.to_numpy())
        where = f" in {zone['name']}"
    hits = []
    for tid, g in s.assign(stop=mask).groupby("track_id"):
        for f0, f1 in _runs(g.f.to_numpy(), g.stop.to_numpy(), gap=1):
            dur = (f1 - f0 + 1) / ds.fps
            if dur >= min_sec:
                hits.append(Hit(f"{ds.classes[tid]} {tid} stopped{where} {dur:.1f}s", f0, dur, [(tid, f0, f1)]))
    return sorted(hits, key=lambda h: h.f)


def count(ds: Dataset, hits: list[Hit], group_by: str = "none") -> list[Hit]:
    """Distinct tracks per group ("class", "minute", or "none"). Each group is a Hit whose score is the count."""
    groups: dict[str, list[Hit]] = {}
    for h in hits:
        if group_by == "minute":
            key = f"minute {int(h.f / ds.fps // 60)}"
        elif group_by == "class":
            key = ds.classes[h.spans[0][0]]
        elif group_by == "none":
            key = "total"
        else:
            raise ValueError("group_by must be 'class', 'minute', or 'none'")
        groups.setdefault(key, []).append(h)
    out = []
    for key, members in groups.items():
        n = len({tid for h in members for tid in h.track_ids})
        out.append(Hit(f"{key}: {n}", min(h.f for h in members), float(n),
                       [s for h in members for s in h.spans]))
    return sorted(out, key=lambda h: h.f)


def highlight(hits: list[Hit], caption: str, summary: str, color: str = HIGHLIGHT_RED) -> dict:
    """The api.md query response for a result set."""
    segments, seen = [], set()
    for h in hits:
        for tid, f0, f1 in h.spans:
            if (tid, f0, f1) not in seen:
                seen.add((tid, f0, f1))
                segments.append({"track_id": int(tid), "f_start": int(f0), "f_end": int(f1), "color": color})
    items = [{"label": h.label, "f": int(h.f), "score": round(float(h.score), 2)} for h in hits]
    return {"summary": summary, "highlight": {"segments": segments, "list": items, "caption": caption}}
