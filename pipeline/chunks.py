"""Chunked segmentation bookkeeping, independent of the model: plan overlapping chunks, map each chunk's
sampled frames back to video frames, stitch object ids across overlaps, and fill the skipped frames.

A raw track is {"source_class": str, "frames": [{f, bbox, centroid, contour}, ...]} sorted by f.
"""

from dataclasses import dataclass

import shapely

SAMPLE_FPS = 6
CHUNK_SEC = 12.0
OVERLAP_SEC = 1.0
MATCH_IOU = 0.3


@dataclass(frozen=True)
class Chunk:
    index: int
    start: float
    duration: float


def plan_chunks(duration: float, chunk_sec: float = CHUNK_SEC, overlap_sec: float = OVERLAP_SEC) -> list[Chunk]:
    """Chunk k covers [k * chunk_sec, k * chunk_sec + chunk_sec + overlap_sec], clipped to the clip."""
    chunks, k = [], 0
    while k * chunk_sec < duration:
        start = k * chunk_sec
        chunks.append(Chunk(k, start, min(chunk_sec + overlap_sec, duration - start)))
        k += 1
    return chunks


def frame_record(f: int, contour: list, centroid: list) -> dict:
    xs, ys = [p[0] for p in contour], [p[1] for p in contour]
    return {"f": f, "bbox": [min(xs), min(ys), max(xs), max(ys)], "centroid": centroid, "contour": contour}


def to_tracks(objects: dict, chunk: Chunk, fps: float, scale: float, sample_fps: float = SAMPLE_FPS) -> list[dict]:
    """One chunk's model output {prompt: {obj_id: [[i, contour, centroid, ...], ...]}} as raw tracks in video
    frames and full-resolution pixels."""
    tracks = []
    for prompt, objs in objects.items():
        for rows in objs.values():
            frames = {}
            for i, contour, centroid, *_ in rows:
                f = round((chunk.start + i / sample_fps) * fps)
                pts = [[round(x * scale), round(y * scale)] for x, y in contour]
                frames[f] = frame_record(f, pts, [round(centroid[0] * scale), round(centroid[1] * scale)])
            tracks.append({"source_class": prompt, "frames": [frames[f] for f in sorted(frames)]})
    return tracks


def inside(a: dict, b: dict) -> float:
    """Share of a's mask area that lies inside b's mask."""
    pa, pb = shapely.make_valid(shapely.Polygon(a["contour"])), shapely.make_valid(shapely.Polygon(b["contour"]))
    area = shapely.area(pa)
    return float(shapely.area(shapely.intersection(pa, pb)) / area) if area else 0.0


def iou(a: dict, b: dict) -> float:
    pa, pb = shapely.make_valid(shapely.Polygon(a["contour"])), shapely.make_valid(shapely.Polygon(b["contour"]))
    union = shapely.area(shapely.union(pa, pb))
    return float(shapely.area(shapely.intersection(pa, pb)) / union) if union else 0.0


def stitch(tracks: list[dict], chunk_tracks: list[dict]) -> list[dict]:
    """Extend `tracks` with the next chunk: each new object joins the existing track of the same class whose
    masks overlap it best (mean IoU over shared frames, at least MATCH_IOU); the rest start new tracks.
    Frames already covered by the earlier chunk are kept from it."""
    scored = []
    for j, new in enumerate(chunk_tracks):
        frames_new = {fr["f"]: fr for fr in new["frames"]}
        for i, old in enumerate(tracks):
            if old["source_class"] != new["source_class"]:
                continue
            shared = [fr for fr in old["frames"] if fr["f"] in frames_new]
            if shared:
                overlap = sum(iou(fr, frames_new[fr["f"]]) for fr in shared) / len(shared)
                if overlap >= MATCH_IOU:
                    scored.append((overlap, i, j))
    out = [dict(t, frames=list(t["frames"])) for t in tracks]
    used_old, used_new = set(), set()
    for _, i, j in sorted(scored, reverse=True):
        if i in used_old or j in used_new:
            continue
        used_old.add(i)
        used_new.add(j)
        last = out[i]["frames"][-1]["f"]
        out[i]["frames"] += [fr for fr in chunk_tracks[j]["frames"] if fr["f"] > last]
    out += [dict(t, frames=list(t["frames"])) for j, t in enumerate(chunk_tracks) if j not in used_new]
    return out


def densify(frames: list[dict], max_gap: int) -> list[dict]:
    """Fill frames skipped by sampling: between two samples at most max_gap frames apart, carry the earlier
    outline along the line between their centroids."""
    out = []
    for a, b in zip(frames, frames[1:], strict=False):
        out.append(a)
        gap = b["f"] - a["f"]
        if 1 < gap <= max_gap:
            dx, dy = b["centroid"][0] - a["centroid"][0], b["centroid"][1] - a["centroid"][1]
            for k in range(1, gap):
                t = k / gap
                sx, sy = round(dx * t), round(dy * t)
                out.append(frame_record(a["f"] + k, [[x + sx, y + sy] for x, y in a["contour"]],
                                        [a["centroid"][0] + sx, a["centroid"][1] + sy]))
    return out + frames[-1:]
