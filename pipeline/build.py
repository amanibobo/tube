"""Raw detector tracks to tubes.json tracks: class mapping and noise filters."""

import numpy as np

from pipeline.chunks import inside

# Detector class -> tubewatch class. Two-wheelers count as bicycles because each carries a rider, who would
# otherwise pair with it as a near miss (and YOLO often calls bicycles motorcycles from above). SAM 3's
# "vehicle" prompt covers cars, buses and trucks.
CLASS_MAP = {"person": "person", "bicycle": "bicycle", "motorcycle": "bicycle", "car": "car", "bus": "car",
             "truck": "car", "vehicle": "car"}
MIN_TRACK_SEC = 1.0
SPECIFICITY = {"person": 0, "bicycle": 1, "motorcycle": 1}  # lower wins; every vehicle class ranks after
SAME_OBJECT = 0.5
STATIC_PX = 4


def is_static(frames: list[dict]) -> bool:
    c = np.array([fr["centroid"] for fr in frames])
    return bool((c.max(0) - c.min(0)).max() < STATIC_PX)


def drop_duplicates(raw: list[dict]) -> list[dict]:
    """One object found by two prompts (SAM 3's "vehicle" also covers bicycles, whole or in part) keeps only
    its most specific class. The less specific track is dropped when, over at least half the shorter track's
    frames, on average SAME_OBJECT or more of its mask lies inside the more specific track's mask."""
    rank = lambda t: SPECIFICITY.get(t["source_class"], 2)  # noqa: E731
    dropped = set()
    for i, a in enumerate(raw):
        fa = {fr["f"]: fr for fr in a["frames"]}
        for j in range(i + 1, len(raw)):
            b = raw[j]
            if rank(a) == rank(b) or i in dropped or j in dropped:
                continue
            shared = [fr for fr in b["frames"] if fr["f"] in fa][::5]
            if len(shared) * 5 < min(len(a["frames"]), len(b["frames"])) / 2:
                continue
            general, specific = (b, a) if rank(b) > rank(a) else (a, b)
            fg = {fr["f"]: fr for fr in general["frames"]}
            fs = {fr["f"]: fr for fr in specific["frames"]}
            if sum(inside(fg[fr["f"]], fs[fr["f"]]) for fr in shared) / len(shared) >= SAME_OBJECT:
                dropped.add(j if general is b else i)
    return [t for k, t in enumerate(raw) if k not in dropped]


def build_tracks(raw: list[dict], fps: float) -> list[dict]:
    """Drop cross-prompt duplicates, tracks under MIN_TRACK_SEC, and person/bicycle tracks whose centroid
    never moves STATIC_PX: on the Astoria clip those were bags and signs (range <= 1 px), while real
    pedestrians ranged 16 px and up."""
    kept = [t for t in drop_duplicates(raw) if len(t["frames"]) >= MIN_TRACK_SEC * fps
            and not (CLASS_MAP[t["source_class"]] != "car" and is_static(t["frames"]))]
    kept.sort(key=lambda t: t["frames"][0]["f"])
    return [{"id": i, "class": CLASS_MAP[t["source_class"]], "source_class": t["source_class"],
             "first_frame": t["frames"][0]["f"], "last_frame": t["frames"][-1]["f"], "frames": t["frames"]}
            for i, t in enumerate(kept, 1)]
