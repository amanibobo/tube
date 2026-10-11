"""Per-frame stats and person/vehicle pairs, derived from tracks. Shared by synth and ingest.

Re-derive an existing dataset from its tubes.json: python -m pipeline.derive data/<id>
"""

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
import shapely

VULNERABLE = ("person", "bicycle")
VEHICLES = ("car",)
# Traffic roles come from the detector's class, so a named track ("pedestrian", "player") keeps traffic geometry.
ROLES = {"person": "vulnerable", "bicycle": "vulnerable", "motorcycle": "vulnerable",
         "car": "vehicle", "bus": "vehicle", "truck": "vehicle", "vehicle": "vehicle"}


def role(track: dict) -> str | None:
    """"vulnerable", "vehicle", or None for anything outside traffic (a dog, a ball)."""
    return ROLES.get(track.get("source_class", track["class"]))
DEFAULT_PARAMS = {"person_h": 130, "close_px": 80, "moving_speed": 50, "stop_speed": 20, "view": "oblique"}
# Oblique clips: "close" is feet to wheel line within 1.5 person heights (about 2.5 m); speeds keep the
# synthetic scene's ratios. Top-view synthetic data sets its own params.
PER_PERSON_H = {"close_px": 1.5, "moving_speed": 50 / 130, "stop_speed": 20 / 130}
PAIR_RADIUS = 1.5
SPEED_WINDOW_SEC = 1.0
OCCLUDED = 0.6
HIDDEN = 0.5


def position(fr: dict, view: str) -> list[float]:
    """Where an object stands: the bottom centre of its mask (feet, wheels) in an oblique view, else the centroid."""
    if view == "top":
        return fr["centroid"]
    x0, _, x1, y1 = fr["bbox"]
    return [(x0 + x1) / 2, y1]


def ground_line(contour: list) -> shapely.Geometry:
    """A vehicle's ground contact in an oblique view: the gentle edges (|dy| < |dx|) of the bottom chain of its
    mask's convex hull. Steep edges are dropped because they climb the vehicle's near side up to the roof."""
    hull = shapely.convex_hull(shapely.MultiPoint(contour))
    if not isinstance(hull, shapely.Polygon):
        pts = np.asarray(contour, float)
        return shapely.Point(pts[pts[:, 1].argmax()])
    ring = np.asarray(hull.exterior.coords)[:-1]
    i0, i1 = int(ring[:, 0].argmin()), int(ring[:, 0].argmax())
    one = np.roll(ring, -i0, axis=0)[: (i1 - i0) % len(ring) + 1]
    two = np.roll(ring, -i1, axis=0)[: (i0 - i1) % len(ring) + 1]
    chain = one if one[:, 1].mean() >= two[:, 1].mean() else two
    edges = [(p, q) for p, q in zip(chain[:-1], chain[1:], strict=True) if abs(q[1] - p[1]) < abs(q[0] - p[0])]
    return shapely.MultiLineString(edges) if edges else shapely.Point(chain[chain[:, 1].argmax()])


def stats_from_tracks(tracks: list[dict], fps: float, view: str = "oblique") -> pd.DataFrame:
    """cx, cy is each object's position (see position()). Velocity is its displacement across a centred
    SPEED_WINDOW_SEC window, so mask jitter on a parked car (doors opening, occlusion) does not read as motion."""
    half = max(1, round(SPEED_WINDOW_SEC * fps / 2))
    parts = []
    for t in tracks:
        f = np.array([fr["f"] for fr in t["frames"]], dtype=float)
        c = np.array([position(fr, view) for fr in t["frames"]], dtype=float)
        lo, hi = np.maximum(f - half, f[0]), np.minimum(f + half, f[-1])
        dt = np.where(hi > lo, (hi - lo) / fps, np.inf)
        vx = (np.interp(hi, f, c[:, 0]) - np.interp(lo, f, c[:, 0])) / dt
        vy = (np.interp(hi, f, c[:, 1]) - np.interp(lo, f, c[:, 1])) / dt
        parts.append(pd.DataFrame({
            "track_id": t["id"], "f": f.astype(int), "t_sec": f / fps,
            "cx": c[:, 0], "cy": c[:, 1], "vx": vx, "vy": vy, "speed": np.hypot(vx, vy),
        }))
    return pd.concat(parts, ignore_index=True).sort_values(["track_id", "f"], ignore_index=True)


def params_for(tracks: list[dict]) -> dict:
    """Scale-dependent thresholds for an oblique clip, from the median box height of the people in it, or of
    whatever was tracked when there are none (person_h is then that object's height)."""
    people = [t for t in tracks if t.get("source_class", t["class"]) == "person"]
    heights = [fr["bbox"][3] - fr["bbox"][1] for t in people or tracks for fr in t["frames"]]
    if not heights:
        return dict(DEFAULT_PARAMS)
    h = float(np.median(heights))
    return {"person_h": round(h), **{k: round(r * h, 1) for k, r in PER_PERSON_H.items()}, "view": "oblique"}


def pairs_from_tracks(tracks: list[dict], stats: pd.DataFrame, max_dist: float, view: str = "oblique") -> pd.DataFrame:
    """Rows (a, b, f, dist, rel_speed): a is a person or two-wheeler, b a vehicle (see ROLES).

    dist in an oblique view runs from the person's ground point to the vehicle's ground line; in a top view
    it is the gap between the two outlines. Two kinds of frame are skipped: over OCCLUDED of the person's mask
    lies inside the vehicle's (that overlap is the camera angle, not proximity), or the vehicle shows under
    HIDDEN of its track's median mask area (partly hidden, so its visible bottom isn't its ground contact)."""
    rows = [
        (t["id"], role(t), fr["f"], *fr["bbox"], fr["contour"])
        for t in tracks if role(t) for fr in t["frames"]
    ]
    frames = pd.DataFrame(rows, columns=["id", "role", "f", "x0", "y0", "x1", "y1", "contour"])
    a = frames[frames.role == "vulnerable"]
    b = frames[frames.role == "vehicle"]
    m = a.merge(b, on="f", suffixes=("_a", "_b"))
    gap_x = np.maximum(0, np.maximum(m.x0_a - m.x1_b, m.x0_b - m.x1_a))
    gap_y = np.maximum(0, np.maximum(m.y0_a - m.y1_b, m.y0_b - m.y1_a))
    m = m[np.hypot(gap_x, gap_y) <= max_dist]
    cols = ["a", "b", "f", "dist", "rel_speed"]
    if m.empty:
        return pd.DataFrame({c: pd.Series(dtype=float if c in ("dist", "rel_speed") else int) for c in cols})
    poly_a = shapely.make_valid(np.array([shapely.Polygon(c) for c in m.contour_a], dtype=object))
    poly_b = shapely.make_valid(np.array([shapely.Polygon(c) for c in m.contour_b], dtype=object))
    if view == "top":
        dist = shapely.distance(poly_a, poly_b)
    else:
        feet = shapely.points([[(x0 + x1) / 2, y1] for x0, x1, y1 in zip(m.x0_a, m.x1_a, m.y1_a, strict=True)])
        dist = shapely.distance(feet, np.array([ground_line(c) for c in m.contour_b], dtype=object))
    inside = shapely.area(shapely.intersection(poly_a, poly_b)) / np.maximum(shapely.area(poly_a), 1e-9)
    usual = {t["id"]: np.median([shapely.Polygon(fr["contour"]).area for fr in t["frames"]])
             for t in tracks if role(t) == "vehicle"}
    shown = shapely.area(poly_b) / np.maximum(m.id_b.map(usual).to_numpy(), 1e-9)
    out = pd.DataFrame({"a": m.id_a.to_numpy(), "b": m.id_b.to_numpy(), "f": m.f.to_numpy(), "dist": dist})
    out = out[(out.dist <= max_dist) & (inside <= OCCLUDED) & (shown >= HIDDEN)]
    v = stats[["track_id", "f", "vx", "vy"]]
    out = out.merge(v.rename(columns={"track_id": "a", "vx": "vxa", "vy": "vya"}), on=["a", "f"])
    out = out.merge(v.rename(columns={"track_id": "b", "vx": "vxb", "vy": "vyb"}), on=["b", "f"])
    out["rel_speed"] = np.hypot(out.vxa - out.vxb, out.vya - out.vyb)
    return out[cols].sort_values(["a", "b", "f"], ignore_index=True)


def write_dataset(out: Path, tubes: dict) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Write tubes.json (adding video.params when absent), stats.parquet and pairs.parquet.
    Zones, video and frames are the caller's."""
    out.mkdir(parents=True, exist_ok=True)
    (out / "agent_cache.json").unlink(missing_ok=True)
    params = tubes["video"].setdefault("params", params_for(tubes["tracks"]))
    params.setdefault("view", "oblique")
    stats = stats_from_tracks(tubes["tracks"], tubes["video"]["fps"], params["view"])
    pairs = pairs_from_tracks(tubes["tracks"], stats, PAIR_RADIUS * params["close_px"], params["view"])
    write_json(out / "tubes.json", tubes)
    stats.to_parquet(out / "stats.parquet", index=False)
    pairs.to_parquet(out / "pairs.parquet", index=False)
    return stats, pairs


def write_json(path: Path, data) -> None:
    """Write whole, then rename, so a reader or a full disk never sees half a file."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, separators=(",", ":")))
    tmp.replace(path)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("data", type=Path)
    root = ap.parse_args().data
    stats, pairs = write_dataset(root, json.loads((root / "tubes.json").read_text()))
    print(f"{len(stats)} stat rows, {len(pairs)} pair rows -> {root}")


if __name__ == "__main__":
    main()
