# Server API contract (v2: video library and uploads)

The viewer and the server are built in parallel against this file. Change it only with both sides updated.

Server: FastAPI on `localhost:8000`, all routes under `/api`. The viewer's Vite dev server proxies `/api` to it (`VITE_API_TARGET`, default :8000). The server serves a library of videos. Each one is a dataset directory under `data/`. Every directory with a `tubes.json` is listed at startup (synthetic, pexels-junction, astoria-20220723), and uploads add new ones. There is no single-dataset mode, and the v1 unscoped routes are removed.

## Dataset directory

```
data/<video_id>/
  meta.json          {id, title, status, stage, progress, error, created, duration_s, credit, source}
                     source is "builtin" or "upload". Also present: notice (trim notice, uploads over 120 s),
                     message (the current stage's sentence), backend ("sam3" or "yolo"), done (finished stages)
  tubes.json         PRD schema; video block also has thumb_stride and thumb_width.
                     source_class per track: the detector's original class name (for example truck)
                     video.credit: attribution string, shown bottom left by the viewer
                     video.params: {person_h, close_px, moving_speed, stop_speed, view}, scale thresholds in px
                     and px/s from the median person height: close_px = 1.5 heights, moving_speed = 50/130 and
                     stop_speed = 20/130 heights per second. view is "oblique" (camera footage) or "top" (the
                     synthetic render, which uses 130, 80, 50, 20)
  stats.parquet      track_id, f, t_sec, cx, cy, vx, vy, speed  (cx, cy are the ground contact point; see below)
  pairs.parquet      a, b, f, dist, rel_speed
  zones.json         [{id, name, polygon: [[x, y], ...]}], pixel coords. Server-only preset areas (the
                     crosswalk) used by zone questions; not exposed to or editable from the viewer
  video.mp4          the normalized clip (H.264, at most 1280x720, at most 120 s)
  frames/000000.jpg  thumbnails every thumb_stride frames, thumb_width px wide, named by frame index
  agent_cache.json   server-internal answer cache, keyed by question and zones
```

## Video status

`status` is one of `queued`, `processing`, `ready` or `failed`. While processing, `stage` is one of `normalizing`, `segmenting`, `building` or `indexing`, and `progress` runs from 0 to 1 over the whole job. `error` is a plain sentence when the job has failed.

## Routes

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/videos` | `[meta]`, newest first |
| POST | `/api/videos` | multipart `file` (+ optional `title`). Returns `meta` with status `queued`. Rejects anything that isn't a video with HTTP 400 and `{error}`. Clips over 120 s are trimmed, and `meta.notice` says so. |
| GET | `/api/videos/{id}` | `meta` |
| DELETE | `/api/videos/{id}` | `{ok: true}`; uploaded videos only, built-in datasets get 403 |
| GET | `/api/videos/{id}/events` | Server-sent events, described below |
| GET | `/api/videos/{id}/tubes` | `tubes.json`. While processing, this holds the tracks finished so far, with `partial: true` and `frames_done` in the video block |
| GET | `/api/videos/{id}/video.mp4` | the clip, with range requests (available once normalizing is done) |
| GET | `/api/videos/{id}/frames/{f}.jpg` | the thumbnail nearest to frame `f` (available once normalizing is done) |
| GET | `/api/videos/{id}/near-misses?top_k=10` | `{list: [{label, f, score, a, b, min_dist}]}`, highest score first (ready only) |
| POST | `/api/videos/{id}/query` | body `{text}`; returns a query response (ready only; otherwise `{error}`) |
| POST | `/api/warm` | `{ok: true}`. Wakes the GPU container. The viewer calls it on load and when a file is picked |

## Events

`text/event-stream`, one JSON object per `data:` line:

- `{"type": "status", "status", "stage", "progress", "message"}` whenever a stage changes or progress moves at least 2%.
- `{"type": "tubes", "frames_done", "tracks": n}` whenever new tracks are available, so the viewer refetches `/tubes`.
- `{"type": "done"}` once the job is ready, then the stream closes.
- `{"type": "error", "message"}` if the job fails, then the stream closes.

A client that connects after the job has finished gets one final `done` or `error` event right away.

## Query response

```json
{
  "summary": "One sentence from the agent.",
  "highlight": {
    "segments": [{"track_id": 14, "f_start": 200, "f_end": 260, "color": "#ff3b30"}],
    "list": [{"label": "person 3 and car 14", "f": 231, "score": 4.2}],
    "caption": "Person-car close passes"
  },
  "cached": true
}
```

On an offline cache miss, or an agent failure, the response is HTTP 200 with `{"error": "plain sentence the viewer can show"}` and no `highlight`.

Class search (two words or fewer) never hits the server. The viewer filters `tubes.json` itself.

## Geometry

Distances and speeds use each object's ground contact point: the bottom center of its mask (its feet or wheels), not the centroid. A pair's distance runs from the person's ground point to the vehicle's ground line: the bottom edges of the vehicle mask's convex hull, without the steep edges that climb the vehicle's near side toward the roof. Near-miss pairs skip frames where the person's mask lies mostly inside the vehicle's mask (overlap over 60% of the person's area). That is occlusion from the camera angle, not proximity.

This applies when `video.params.view` is `"oblique"`. The synthetic dataset is a top-down render whose image plane is the ground, so it uses `"top"`: centroids for positions and the gap between outlines for distances.
