"""The seven geometry tools, as pure functions over an in-memory Dataset.

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

from pipeline.derive import DEFAULT_PARAMS, VEHICLES, VULNERABLE

RUN_GAP = 5
HIGHLIGHT_RED = "#ff3b30"


@dataclass
class Dataset:
    root: Path
    video: dict
    classes: dict[int, str]
    stats: pd.DataFrame
    pairs: pd.DataFrame
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
    return Dataset(
        root=root,
        video=tubes["video"],
        classes={t["id"]: t["class"] for t in tubes["tracks"]},
        stats=pd.read_parquet(root / "stats.parquet"),
        pairs=pd.read_parquet(root / "pairs.parquet"),
        zones=json.loads(zones_path.read_text()) if zones_path.exists() else [],
    )


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
                  sort_by_speed: bool = False, top_k: int | None = None) -> list[Hit]:
    """Tracks by class, peak speed (px/s), duration, and overlap with a time range. Score = peak speed."""
    hits = []
    for tid, g in ds.stats.groupby("track_id"):
        if cls is not None and ds.classes[tid] != cls:
            continue
        peak = g.speed.max()
        f0, f1 = int(g.f.iloc[0]), int(g.f.iloc[-1])
        if min_speed is not None and peak < min_speed or max_speed is not None and peak > max_speed:
            continue
        if min_duration_sec is not None and (f1 - f0 + 1) / ds.fps < min_duration_sec:
            continue
        if t_start is not None and f1 / ds.fps < t_start or t_end is not None and f0 / ds.fps > t_end:
            continue
        f_peak = int(g.f.iloc[int(np.argmax(g.speed.to_numpy()))])
        hits.append(Hit(f"{ds.classes[tid]} {tid}, peak {peak:.0f} px/s", f_peak, float(peak), [(tid, f0, f1)]))
    if sort_by_speed:
        hits.sort(key=lambda h: -h.score)
    return hits[:top_k] if top_k else hits


def near(ds: Dataset, class_a: str = "person", class_b: str = "car", max_dist: float | None = None,
         moving_only: bool = True, t_start: float | None = None, t_end: float | None = None) -> list[Hit]:
    """Episodes where a person/bicycle and a vehicle are within max_dist px (default: the clip's close_px).
    Score = near-miss score."""
    if class_a in VEHICLES:
        class_a, class_b = class_b, class_a
    if class_a not in VULNERABLE or class_b not in VEHICLES:
        raise ValueError(f"near() covers {'/'.join(VULNERABLE)} vs {'/'.join(VEHICLES)} only")
    p = ds.pairs[ds.pairs.dist <= (max_dist or ds.params["close_px"])]
    p = p[p.a.map(ds.classes).eq(class_a) & p.b.map(ds.classes).eq(class_b)]
    speed = ds.stats.set_index(["track_id", "f"]).speed
    p = p.assign(v=speed.reindex(pd.MultiIndex.from_arrays([p.b, p.f])).to_numpy())
    if moving_only:
        p = p[p.v > ds.params["moving_speed"]]
    hits = []
    for (a, b), g in p.groupby(["a", "b"]):
        frames = g.f.to_numpy()
        for f0, f1 in _runs(frames, np.ones(len(frames), bool), gap=15):
            ep = g[(g.f >= f0) & (g.f <= f1)]
            closest = ep[ep.dist <= ep.dist.min() + 0.5]
            best = closest.iloc[len(closest) // 2]
            f = int(best.f)
            if not _in_time(f, ds, t_start, t_end):
                continue
            score = float(best.v) / max(float(best.dist), 1.0)
            label = f"{ds.classes[a]} {a} and {ds.classes[b]} {b}, {best.dist:.0f} px at {best.v:.0f} px/s"
            hits.append(Hit(label, f, score, [(a, f0, f1), (b, f0, f1)], float(best.dist),
                            {"a": int(a), "b": int(b)}))
    hits.sort(key=lambda h: -h.score)
    return hits


def rank_near_misses(ds: Dataset, top_k: int = 10, t_start: float | None = None,
                     t_end: float | None = None) -> list[Hit]:
    """PRD v1: per person/bicycle-vehicle pair, the closest moving pass under close_px, scored
    vehicle speed / min distance, highest first."""
    best: dict[tuple[int, int], Hit] = {}
    for cls in VULNERABLE:
        for h in near(ds, cls, VEHICLES[0], None, True, t_start, t_end):
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
