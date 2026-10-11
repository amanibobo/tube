"""Plain-English questions to highlight sets: Claude plans tool calls over server.tools, cached on disk."""

import hashlib
import json
import os
import re
import threading

import anthropic

from server import tools as T
from server.plans import plans_for
from server.tools import Dataset, Hit

MODEL = "claude-sonnet-5-5"
MAX_TURNS = 8
HITS_SHOWN = 30

SYSTEM = """You answer questions about a video by calling geometry tools.

Every tracked object is a track with a position per frame; the context lists the clip's classes (for traffic:
car, person, bicycle; for other clips whatever was tracked, such as dog or player). Use those class names
exactly. Speeds are px/s and distances px.
Tools return a result_id plus rows. Pass a result_id to later tools to narrow or count it.
Finish every answer by calling highlight exactly once with the result_ids to show, a short caption,
and a one-sentence summary that states the answer. Never answer in plain text alone.
Highlight only what the summary talks about. When a result holds more rows than the answer
(for example near() rows with moving cars when the question is about stopped ones), pass
track_ids to highlight so only rows involving those tracks are shown.

Typical plans:
- "every time a person and a car got close": near(person, car, moving_only) -> highlight
- "which cars stopped in the crosswalk": filter_tracks(car) -> stopped(min_sec 1, zone crosswalk) -> highlight
- "top 3 most dangerous moments": rank_near_misses(top_k 3) -> highlight
- "how many people crossed per minute": filter_tracks(person) -> in_zone(crosswalk) -> count(minute) -> highlight
- "fastest car": filter_tracks(car, sort_by peak_speed, top_k 1) -> highlight
- "when did two dogs get closest": near(dog, dog) -> highlight, track_ids of the first row
- "which dog moved the most": filter_tracks(dog, sort_by distance, top_k 1) -> highlight"""

TIME_PROPS = {
    "t_start": {"type": "number", "description": "Only results at or after this time, seconds."},
    "t_end": {"type": "number", "description": "Only results at or before this time, seconds."},
}
TRACKS_PROPS = {
    "result_id": {"type": "string", "description": "Restrict to the tracks in this earlier result."},
    "track_ids": {"type": "array", "items": {"type": "integer"}, "description": "Restrict to these tracks."},
}
CLASS = {"type": "string", "description": "A class this clip has, as listed in the context (e.g. car, dog)."}

TOOLS = [
    {"name": "filter_tracks", "description": "Tracks by class, peak speed, duration and time range. Score is "
     "the track's peak speed, or with sort_by distance the total px it traveled.",
     "input_schema": {"type": "object", "properties": {
         "cls": CLASS,
         "min_speed": {"type": "number", "description": "Minimum peak speed, px/s."},
         "max_speed": {"type": "number", "description": "Maximum peak speed, px/s."},
         "min_duration_sec": {"type": "number"},
         "sort_by": {"type": "string", "enum": ["peak_speed", "distance"],
                     "description": "Highest first: peak speed (fastest) or total distance traveled (moved most)."},
         "top_k": {"type": "integer"}, **TIME_PROPS}}},
    {"name": "near", "description": "Episodes where tracks of two classes (or two tracks of one class) came "
     "within max_dist px. Person or bicycle vs car: score is car speed / distance, highest first. Any other "
     "pair: score is the gap between outlines in px, closest first.",
     "input_schema": {"type": "object", "properties": {
         "class_a": CLASS, "class_b": CLASS,
         "max_dist": {"type": "number", "description": "Pixels. Default: the clip's close distance."},
         "moving_only": {"type": "boolean",
                         "description": "Only while moving. Default true for person/bicycle vs car, else false."},
         **TIME_PROPS}, "required": ["class_a", "class_b"]}},
    {"name": "in_zone", "description": "Visits into a drawn zone (entry/exit frames). Score is dwell seconds.",
     "input_schema": {"type": "object", "properties": {
         "zone_id": {"type": "string", "description": "Zone id or name."},
         "min_dwell_sec": {"type": "number"}, **TRACKS_PROPS}, "required": ["zone_id"]}},
    {"name": "stopped", "description": "Intervals where a track stood still for min_sec, optionally inside a zone.",
     "input_schema": {"type": "object", "properties": {
         "min_sec": {"type": "number", "description": "Default 1."},
         "zone_id": {"type": "string", "description": "Zone id or name."}, **TRACKS_PROPS}}},
    {"name": "rank_near_misses", "description": "Traffic only: person/bicycle-car near misses ranked by car "
     "speed / min distance, one per pair, highest first. Empty when the clip has no people and cars.",
     "input_schema": {"type": "object", "properties": {"top_k": {"type": "integer"}, **TIME_PROPS}}},
    {"name": "count", "description": "Distinct tracks in a result, grouped by class or minute.",
     "input_schema": {"type": "object", "properties": {
         "result_id": {"type": "string"},
         "group_by": {"type": "string", "enum": ["class", "minute", "none"]}}, "required": ["result_id"]}},
    {"name": "highlight", "description": "Show results in the viewer. Always the last call.",
     "input_schema": {"type": "object", "properties": {
         "result_ids": {"type": "array", "items": {"type": "string"}},
         "caption": {"type": "string"},
         "summary": {"type": "string", "description": "One sentence that answers the question."},
         "track_ids": {"type": "array", "items": {"type": "integer"},
                       "description": "Keep only rows involving any of these tracks."},
         "color": {"type": "string", "description": "Hex color. Default red."}},
         "required": ["result_ids", "caption", "summary"]}},
]


def normalize(text: str) -> str:
    return " ".join(re.sub(r"[^\w\s]", " ", text.lower()).split())


def zones_key(ds: Dataset) -> str:
    return hashlib.sha1(json.dumps(ds.zones, sort_keys=True).encode()).hexdigest()[:12]


def is_offline() -> bool:
    return os.environ.get("TUBEWATCH_OFFLINE") == "1" or not os.environ.get("ANTHROPIC_API_KEY")


class Agent:
    """Owns the answer cache for one dataset. A cache entry is valid only for the zones it was computed with."""

    def __init__(self, ds: Dataset):
        self.ds = ds
        self.path = ds.root / "agent_cache.json"
        self.cache: dict[str, dict] = json.loads(self.path.read_text()) if self.path.exists() else {}
        self.lock = threading.Lock()

    def seed_demo(self) -> list[str]:
        """(Re)answer this clip's demo questions from their tool plans for the current zones. Returns the keys
        written."""
        key, written = zones_key(self.ds), []
        for q, plan in plans_for(self.ds).items():
            try:
                self.cache[q] = {**plan(self.ds), "zones_key": key}
            except ValueError as e:
                self.cache[q] = {"error": str(e), "zones_key": key}
            written.append(q)
        self._save()
        return written

    def answer(self, text: str) -> dict:
        q = normalize(text)
        entry = self.cache.get(q)
        if entry and entry.get("zones_key") == zones_key(self.ds):
            if "error" in entry:
                return {"error": entry["error"]}
            return {**{k: v for k, v in entry.items() if k != "zones_key"}, "cached": True}
        if is_offline():
            return {"error": "Offline, and this question has no cached answer. Try one of the demo questions."}
        try:
            result = run_agent(self.ds, text)
        except anthropic.APIConnectionError:
            return {"error": "Could not reach the agent. Check the network and try again."}
        except anthropic.RateLimitError:
            return {"error": "The agent is rate limited. Try again in a moment."}
        except anthropic.APIStatusError as e:
            return {"error": f"The agent failed with HTTP {e.status_code}."}
        if "error" not in result:
            with self.lock:
                self.cache[q] = {**result, "zones_key": zones_key(self.ds)}
                self._save()
        return {**result, "cached": False}

    def _save(self) -> None:
        self.path.write_text(json.dumps(self.cache, indent=1))


def context(ds: Dataset) -> str:
    v = ds.video
    counts: dict[str, int] = {}
    for c in ds.classes.values():
        counts[c] = counts.get(c, 0) + 1
    zones = ", ".join(f"{z['name']} (id {z['id']})" for z in ds.zones) or "none drawn"
    p = ds.params
    unit = "person" if "person" in counts else max(counts, key=counts.get, default="object")
    classes = ", ".join(f"{c} ({n} tracks)" for c, n in sorted(counts.items()))
    return (f"Clip {v['id']}: {v['frames']} frames at {v['fps']} fps ({v['frames'] / v['fps']:.0f}s), "
            f"{v['width']}x{v['height']} px. Classes: {classes}. Zones: {zones}. Scale: a {unit} is about "
            f"{p['person_h']} px tall, close means within {p['close_px']:g} px, moving means faster than "
            f"{p['moving_speed']:g} px/s, stopped means slower than {p['stop_speed']:g} px/s.")


def run_agent(ds: Dataset, text: str, client: anthropic.Anthropic | None = None) -> dict:
    client = client or anthropic.Anthropic()
    results: dict[str, list[Hit]] = {}
    messages = [{"role": "user", "content": f"{context(ds)}\n\nQuestion: {text}"}]
    for _ in range(MAX_TURNS):
        resp = client.beta.messages.create(
            model=MODEL, max_tokens=4096, system=SYSTEM, tools=TOOLS, messages=messages,
            output_config={"effort": "low"},
            betas=["server-side-fallback-2026-07-01"], fallbacks="default",
        )
        if resp.stop_reason == "refusal":
            return {"error": "The agent declined to answer that question."}
        messages.append({"role": "assistant", "content": resp.content})
        uses = [b for b in resp.content if b.type == "tool_use"]
        if not uses:
            return {"error": "The agent answered without a highlight. Try rephrasing the question."}
        replies = []
        for u in uses:
            if u.name == "highlight":
                try:
                    hits = [h for rid in u.input["result_ids"] for h in results[rid]]
                    if keep := set(u.input.get("track_ids") or ()):
                        hits = [h for h in hits if keep & set(h.track_ids)]
                except KeyError as e:
                    replies.append(tool_reply(u.id, f"unknown result_id {e}", error=True))
                    continue
                return T.highlight(hits, u.input["caption"], u.input["summary"],
                                   u.input.get("color", T.HIGHLIGHT_RED))
            try:
                hits = call_tool(ds, u.name, dict(u.input), results)
            except (ValueError, KeyError, TypeError) as e:
                replies.append(tool_reply(u.id, f"{type(e).__name__}: {e}", error=True))
                continue
            rid = f"r{len(results) + 1}"
            results[rid] = hits
            replies.append(tool_reply(u.id, json.dumps(describe(ds, rid, hits))))
        messages.append({"role": "user", "content": replies})
    return {"error": "The agent ran out of steps before answering."}


def tool_reply(tool_use_id: str, content: str, error: bool = False) -> dict:
    return {"type": "tool_result", "tool_use_id": tool_use_id, "content": content, "is_error": error}


def describe(ds: Dataset, rid: str, hits: list[Hit]) -> dict:
    rows = [{"label": h.label, "f": h.f, "t_sec": round(h.f / ds.fps, 1), "score": round(h.score, 2),
             "track_ids": h.track_ids} for h in hits[:HITS_SHOWN]]
    return {"result_id": rid, "count": len(hits), "rows": rows, "truncated": len(hits) > HITS_SHOWN}


def call_tool(ds: Dataset, name: str, args: dict, results: dict[str, list[Hit]]) -> list[Hit]:
    """Map one tool_use block onto server.tools, resolving result_id into track ids."""
    if "result_id" in args and name != "count":
        args["track_ids"] = sorted({t for h in results[args.pop("result_id")] for t in h.track_ids})
    match name:
        case "filter_tracks":
            return T.filter_tracks(ds, **args)
        case "near":
            return T.near(ds, **args)
        case "in_zone":
            return T.in_zone(ds, **args)
        case "stopped":
            return T.stopped(ds, **args)
        case "rank_near_misses":
            return T.rank_near_misses(ds, **args)
        case "count":
            return T.count(ds, results[args["result_id"]], args.get("group_by", "none"))
    raise ValueError(f"unknown tool {name}")

