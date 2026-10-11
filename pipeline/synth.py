"""Render a deterministic synthetic intersection into data/synthetic with known answers in expected.json.

Run: python -m pipeline.synth [--out data/synthetic] [--seed 7]
"""

import argparse
import json
import math
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from pipeline.derive import DEFAULT_PARAMS, write_dataset

W, H, FPS, SECONDS = 1280, 720, 30, 80
N_FRAMES = FPS * SECONDS
THUMB_STRIDE, THUMB_WIDTH = 5, 320
ROAD = (250, 580)
WEST_Y, EAST_Y = 330, 490
CROSSWALK = [[540, 250], [740, 250], [740, 580], [540, 580]]
CURB_TOP, CURB_BOTTOM = 120, 700
WALK = 110.0
SHAPES = {"car": (220, 90, 20), "person": (50, 130, 0), "bicycle": (120, 50, 12)}
CLEARANCE = 130
NEAR_MISSES = [  # (t_pass, gap px, car speed px/s), most dangerous first
    (46.0, 8, 420),
    (36.0, 20, 340),
    (12.0, 35, 260),
    (52.5, 60, 150),
]
STOP_IN_CROSSWALK = (25.0, 30.0)
FASTEST = 700


@dataclass
class Actor:
    cls: str
    keys: list[tuple[float, float, float]]
    color: tuple[int, int, int]
    id: int = 0

    def pos(self, t: float) -> tuple[float, float] | None:
        ts = [k[0] for k in self.keys]
        if t < ts[0] or t > ts[-1]:
            return None
        return float(np.interp(t, ts, [k[1] for k in self.keys])), float(np.interp(t, ts, [k[2] for k in self.keys]))


def outline(cls: str, cx: float, cy: float) -> list[list[int]]:
    w, h, r = SHAPES[cls]
    if r == 0:
        pts = [(cx + w / 2 * math.cos(a), cy + h / 2 * math.sin(a)) for a in np.radians(np.arange(0, 360, 15))]
    else:
        pts = []
        corners = [(w / 2 - r, h / 2 - r, 0), (-w / 2 + r, h / 2 - r, 90), (-w / 2 + r, -h / 2 + r, 180),
                   (w / 2 - r, -h / 2 + r, 270)]
        for ox, oy, start in corners:
            for a in np.radians(np.linspace(start, start + 90, 6)):
                pts.append((cx + ox + r * math.cos(a), cy + oy + r * math.sin(a)))
    return [[int(np.clip(round(x), 0, W - 1)), int(np.clip(round(y), 0, H - 1))] for x, y in pts]


def car(direction: int, t640: float, speed: float, color, stops=()) -> Actor:
    """A car in the east (+1) or west (-1) lane at x=640 at t640. stops: (x, arrive_t, leave_t, decel_s)."""
    y = EAST_Y if direction > 0 else WEST_Y
    x_in, x_out = (-150, W + 150) if direction > 0 else (W + 150, -150)
    if not stops:
        return Actor("car", [(t640 - abs(640 - x_in) / speed, x_in, y), (t640 + abs(x_out - 640) / speed, x_out, y)],
                     color)
    x_stop, arrive, leave, decel = stops
    slow = 120 * direction
    keys = [(arrive - decel - abs(x_stop - slow - x_in) / speed, x_in, y), (arrive - decel, x_stop - slow, y),
            (arrive, x_stop, y), (leave, x_stop, y), (leave + decel, x_stop + slow, y),
            (leave + decel + abs(x_out - x_stop - slow) / speed, x_out, y)]
    return Actor("car", keys, color)


def crossing(x: float, start: float, down: bool, color, wait: tuple[float, float, float] | None = None) -> Actor:
    """A person crossing the road at column x, curb to curb. wait: (y, from_t, until_t) pause mid-road."""
    y0, y1 = (CURB_TOP, CURB_BOTTOM) if down else (CURB_BOTTOM, CURB_TOP)
    if wait is None:
        return Actor("person", [(start, x, y0), (start + abs(y1 - y0) / WALK, x, y1)], color)
    wy, t_from, t_until = wait
    return Actor("person", [(t_from - abs(wy - y0) / WALK, x, y0), (t_from, x, wy), (t_until, x, wy),
                            (t_until + abs(y1 - wy) / WALK, x, y1)], color)


def near_miss(t_pass: float, gap: int, speed: float, rng) -> tuple[Actor, Actor]:
    """Person waits on the centre line while an eastbound car passes `gap` px below them at `speed`.
    They step off once the car is 300 px past, so the scripted gap stays the closest approach."""
    wait_y = EAST_Y - SHAPES["car"][1] // 2 - gap - SHAPES["person"][1] // 2
    resume = t_pass + max(1.2, 300 / speed)
    person = crossing(640, 0, True, person_color(rng), wait=(wait_y, t_pass - 1.5, resume))
    return person, car(+1, t_pass, speed, car_color(rng))


def car_color(rng) -> tuple[int, int, int]:
    return tuple(int(c) for c in rng.choice([[60, 60, 200], [200, 120, 40], [230, 230, 230], [40, 40, 40],
                                             [50, 160, 220], [140, 70, 160]]))


def person_color(rng) -> tuple[int, int, int]:
    return tuple(int(c) for c in rng.choice([[30, 90, 230], [200, 60, 60], [40, 180, 230], [120, 40, 120]]))


def min_gap(a: Actor, others: list[Actor], grid: np.ndarray) -> float:
    """Smallest bounding-box gap between `a` and any of `others` over the time grid."""
    best = math.inf
    aw, ah, _ = SHAPES[a.cls]
    for t in grid:
        pa = a.pos(t)
        if pa is None:
            continue
        for o in others:
            po = o.pos(t)
            if po is None:
                continue
            ow, oh, _ = SHAPES[o.cls]
            gx = max(0.0, abs(pa[0] - po[0]) - (aw + ow) / 2)
            gy = max(0.0, abs(pa[1] - po[1]) - (ah + oh) / 2)
            best = min(best, math.hypot(gx, gy))
    return best


def scenario(seed: int) -> tuple[list[Actor], dict]:
    rng = np.random.default_rng(seed)
    named = [near_miss(*nm, rng) for nm in NEAR_MISSES]
    stop_car = car(-1, 0, 300, car_color(rng), stops=(640, *STOP_IN_CROSSWALK, 1.2))
    yield_car = car(-1, 0, 280, car_color(rng), stops=(900, 62.0, 66.5, 1.2))
    fastest = car(-1, 58.0, FASTEST, car_color(rng))
    bike = Actor("bicycle", [(26.0, -70, 548), (26.0 + 1420 / 200, 1350, 548)], (60, 170, 60))
    plain = [crossing(600, 2.0, True, person_color(rng)), crossing(680, 18.0, False, person_color(rng)),
             crossing(620, 62.5, True, person_color(rng)), crossing(660, 70.0, False, person_color(rng))]
    walkers = [Actor("person", [(5.0, -30, 110), (5.0 + 1340 / 80, 1310, 110)], person_color(rng)),
               Actor("person", [(40.0, 1310, 705), (40.0 + 1340 / 80, -30, 705)], person_color(rng))]
    # Walks just left of the crosswalk, around the car stopped in it, 14 px from its side.
    detour_x = 640 - SHAPES["car"][0] / 2 - 14 - SHAPES["person"][0] / 2
    detour = crossing(detour_x, 25.3, True, person_color(rng))

    crossers = plain + [p for p, _ in named]
    people = crossers + walkers + [detour]
    grid = np.arange(0, SECONDS, 1 / FPS)
    busy = {-1: [(18.0, 36.0), (54.0, 72.0)], 1: [(24.0, 36.0)] + [(t - 3, t + 3) for t, _, _ in NEAR_MISSES]}
    fillers = []
    for _ in range(400):
        if len(fillers) == 8:
            break
        d, t, v = int(rng.choice([-1, 1])), float(rng.uniform(3, 77)), float(rng.uniform(220, 360))
        if any(lo < t + 3.5 and t - 3.5 < hi for lo, hi in busy[d]):
            continue
        candidate = car(d, t, v, car_color(rng))
        if min_gap(candidate, people, grid) < CLEARANCE:
            continue
        busy[d].append((t - 1, t + 1))
        fillers.append(candidate)

    actors = [a for pair in named for a in pair] + [stop_car, yield_car, fastest, bike]
    actors += plain + walkers + fillers + [detour]
    actors.sort(key=lambda a: a.keys[0][0])
    for i, a in enumerate(actors, 1):
        a.id = i

    x0, y0 = CROSSWALK[0]
    x1, y1 = CROSSWALK[2]
    per_minute: dict[str, int] = {}
    for a in crossers:
        entry = next(t for t in grid if (p := a.pos(t)) and x0 <= p[0] <= x1 and y0 <= p[1] <= y1)
        per_minute[str(int(entry // 60))] = per_minute.get(str(int(entry // 60)), 0) + 1
    near = [{"person": p.id, "car": c.id, "f": round(t * FPS), "min_dist": gap, "car_speed": v, "score": v / gap}
            for (p, c), (t, gap, v) in zip(named, NEAR_MISSES, strict=True)]
    expected = {
        "fps": FPS,
        "crosswalk_zone": {"id": "crosswalk", "name": "crosswalk", "polygon": CROSSWALK},
        "near_misses": near,
        "close_pairs": [[n["person"], n["car"]] for n in near],
        "top3_near_misses": [[n["person"], n["car"]] for n in near[:3]],
        "stopped_in_crosswalk": {"car": stop_car.id, "f_start": round(STOP_IN_CROSSWALK[0] * FPS),
                                 "f_end": round(STOP_IN_CROSSWALK[1] * FPS)},
        "stopped_outside_crosswalk": {"car": yield_car.id},
        "close_to_stopped_car": [detour.id, stop_car.id],
        "fastest_car": {"car": fastest.id, "speed": FASTEST},
        "crossings_per_minute": dict(sorted(per_minute.items())),
        "crossing_people": sorted(a.id for a in crossers),
    }
    return actors, expected


def build_tracks(actors: list[Actor]) -> list[dict]:
    tracks = []
    for a in actors:
        frames = []
        for fi in range(N_FRAMES):
            p = a.pos(fi / FPS)
            if p is None or not (0 <= p[0] < W and 0 <= p[1] < H):
                continue
            contour = outline(a.cls, *p)
            xs, ys = [c[0] for c in contour], [c[1] for c in contour]
            frames.append({"f": fi, "bbox": [min(xs), min(ys), max(xs), max(ys)],
                           "centroid": [round(p[0]), round(p[1])], "contour": contour})
        if frames:
            tracks.append({"id": a.id, "class": a.cls, "first_frame": frames[0]["f"],
                           "last_frame": frames[-1]["f"], "frames": frames})
    return tracks


def background() -> np.ndarray:
    img = np.full((H, W, 3), (70, 110, 80), np.uint8)
    cv2.rectangle(img, (0, 40), (W, H), (175, 175, 170), -1)
    cv2.rectangle(img, (0, ROAD[0]), (W, ROAD[1]), (75, 75, 78), -1)
    mid = (WEST_Y + EAST_Y) // 2
    for x in range(0, W, 120):
        cv2.line(img, (x, mid), (x + 60, mid), (40, 200, 230), 4)
    for y in range(ROAD[0] + 10, ROAD[1] - 20, 44):
        cv2.rectangle(img, (CROSSWALK[0][0], y), (CROSSWALK[1][0], y + 24), (235, 235, 235), -1)
    return img


def render(tracks: list[dict], actors: list[Actor], out: Path) -> None:
    colors = {a.id: a.color for a in actors}
    by_frame: dict[int, list[tuple[int, list]]] = {}
    for t in sorted(tracks, key=lambda t: t["class"] != "car"):
        for fr in t["frames"]:
            by_frame.setdefault(fr["f"], []).append((t["id"], fr["contour"]))
    bg = background()
    frames_dir = out / "frames"
    shutil.rmtree(frames_dir, ignore_errors=True)
    frames_dir.mkdir(parents=True)
    ff = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}",
         "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
         "-crf", "23", "-movflags", "+faststart", str(out / "video.mp4")],
        stdin=subprocess.PIPE)
    for fi in range(N_FRAMES):
        img = bg.copy()
        for tid, contour in by_frame.get(fi, []):
            pts = np.array(contour, np.int32)
            cv2.fillPoly(img, [pts], colors[tid])
            cv2.polylines(img, [pts], True, (20, 20, 20), 2)
        ff.stdin.write(img.tobytes())
        if fi % THUMB_STRIDE == 0:
            thumb = cv2.resize(img, (THUMB_WIDTH, THUMB_WIDTH * H // W), interpolation=cv2.INTER_AREA)
            cv2.imwrite(str(frames_dir / f"{fi:06d}.jpg"), thumb, [cv2.IMWRITE_JPEG_QUALITY, 80])
    ff.stdin.close()
    if ff.wait() != 0:
        raise SystemExit("ffmpeg failed")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("data/synthetic"))
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    actors, expected = scenario(args.seed)
    tracks = build_tracks(actors)
    tubes = {"video": {"id": "synthetic", "fps": FPS, "width": W, "height": H, "frames": N_FRAMES,
                       "thumb_stride": THUMB_STRIDE, "thumb_width": THUMB_WIDTH, "credit": "Synthetic scene",
                       "params": {**DEFAULT_PARAMS, "view": "top"}}, "tracks": tracks}
    stats, pairs = write_dataset(args.out, tubes)
    (args.out / "zones.json").write_text(json.dumps([expected["crosswalk_zone"]], indent=1))
    (args.out / "expected.json").write_text(json.dumps(expected, indent=1))
    render(tracks, actors, args.out)
    counts = {c: sum(t["class"] == c for t in tracks) for c in ("car", "person", "bicycle")}
    print(f"{len(tracks)} tracks {counts}, {len(stats)} stat rows, {len(pairs)} pair rows -> {args.out}")


if __name__ == "__main__":
    main()
