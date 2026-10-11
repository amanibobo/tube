# Tubewatch PRD: Space-Time Traffic Search

Oct 10, 2026 · @amani bobo

> Build decisions in `decisions.md` override this document where they conflict.

## Overview

Tubewatch turns traffic camera footage into a 3D space-time cube you can search by behavior. Every car, person, and bike becomes a tube through time. You type "every near miss between a pedestrian and a car" and the matching tube segments light up, ranked, each one click away from the video moment.

**Problem.** Cities have thousands of fixed traffic cameras, and almost nobody watches the footage. Dangerous intersections are found from crash reports, after someone is hurt. Near misses happen far more often than crashes, and they predict where crashes will happen, but finding them means a person scrubbing hours of video.

**Core idea.** A fixed-camera video is a block with axes x, y, and time. Segment and track each object, stack its outline per frame, and the object becomes a tube. The tube's shape encodes its behavior:

- **Slope** = speed. A steep tilt moves fast across the frame.
- **A straight run along time** = stopped or dwelling.
- **Gaps** = occlusion.
- **Two tubes close together** = an interaction, or a near miss.

Questions about time become questions about geometry, which code answers exactly and an LLM can drive through tools.

**Why now.** Text-prompted video segmentation (SAM 3) and fast trackers make per-object tubes cheap to compute from any clip. LLM tool calling makes plain-English questions runnable as precise geometric queries.

## Users and goals

The primary user is a city traffic safety engineer (Vision Zero teams, DOT staff, consultants doing intersection safety studies). They need evidence of where and why conflicts happen, without watching footage.

| User | Job to be done | What they get |
| --- | --- | --- |
| Traffic safety engineer | Find dangerous intersections before crashes | Ranked near-miss clips plus counts per intersection |
| Transportation planner | Justify a redesign (bump-out, signal timing) | Before/after behavior stats from the same camera |
| Hackathon judge | Understand the product in 3 minutes | A cube that answers a spoken question visibly |

**Goals (hackathon)**

1. Ingest a fixed-camera intersection clip of 2 to 10 minutes and produce queryable tubes.
2. Answer at least 5 behavior questions in plain English, with highlights in the cube and jump-to-video.
3. Produce a ranked near-miss list with one-click clips.
4. Run the full demo offline from precomputed data, with no live GPU dependency.

**Non-goals**

- Moving or panning cameras (dashcams, broadcast). Fixed cameras only.
- Real-time or live-stream processing.
- Metric-accurate speeds. Hackathon speeds are in pixels per second unless a ground-plane homography is added (P1).
- Identifying individuals. No faces, plates, or re-identification across cameras.

## Demo scenario

The product exists to make this 3-minute walkthrough work. Every P0 feature maps to a step. Footage: a fixed phone on a tripod at an intersection near GSU.

1. **Hook (15s).** Play the raw clip. "Cities have thousands of these cameras. Nobody watches them."
2. **The fold (20s).** The video collapses into the cube. Drag the frame plane through it. Point out a tilted tube (moving) and an upright run (stopped).
3. **Object search (15s).** Type "car". Car tubes light up, everything else fades. Then "person".
4. **Behavior search (45s).** Ask "every time a person and a car got close". Matching segments glow red, a ranked list appears, clicking the top result jumps the frame plane and video to that moment.
5. **Zone (30s).** Draw over the crosswalk. It extrudes into a prism. Ask "which cars stopped inside the crosswalk". Piercing tubes light up.
6. **Synopsis (15s).** "Here is the whole clip as 20 seconds of just the near misses." Play it.
7. **Pitch (20s).** "Crash reports find danger after someone is hurt. This finds it from near misses, before."

Optional closer if time allows: switch to the archive view (several clips or days as strips), query "near miss", and show hits across all of them.

## Features and scope

P0 is the demo and nothing else. P1 makes it feel like a product. P2 is post-hackathon.

| Priority | Feature | Acceptance criteria |
| --- | --- | --- |
| P0 | Offline ingest pipeline | One command turns an .mp4 into `tubes.json` + `stats.parquet` + frame thumbnails |
| P0 | Contour cube viewer | Tubes render as stacked outline loops, colored by track, faint video volume behind, orbit controls, 60fps on a laptop for 2,000+ frames |
| P0 | Frame plane scrubber | Dragging the plane through time shows that frame and syncs a video player |
| P0 | Class search | Typing "car" or "person" highlights matching tubes and fades the rest in under 100ms |
| P0 | Behavior query agent | 5 scripted questions return correct track IDs and frame ranges, highlighted in the cube |
| P0 | Near-miss ranking | Ranked list of person-vehicle conflicts with min distance, timestamp, and a jump button |
| P1 | Zone drawing | Polygon drawn on the frame plane extrudes to a prism; entry, dwell, and stop queries use it |
| P1 | Cutout tube mode | Toggle to render tubes as stacked image cutouts of the object instead of contours |
| P1 | Object callouts | Floating thumbnail per tube, linked to it by a dotted line, as in the reference video |
| P1 | Synopsis export | Render an .mp4 of only the matched tubes, time-shifted to overlap |
| P1 | Ground-plane homography | Click 4 points to map pixels to meters, so speeds and distances are real units |
| P2 | Archive view | Many clips or days as strips on a plane; one query highlights hits across all of them |
| P2 | Semantic search | CLIP/VLM embeddings per tube segment for open-ended queries ("cyclist on sidewalk") |
| P2 | Before/after compare | Two cubes of the same intersection side by side with stats deltas |

## Architecture

All heavy compute runs once, offline. The live app only reads precomputed files and runs cheap geometry, so the demo cannot stall on a GPU.

(The original doc embedded an architecture diagram: offline pipeline → data files → live app.)

The data files are the contract between the two halves: the pipeline and the viewer can be built in parallel against the same schema.

**Stack**

| Layer | Choice | Fallback |
| --- | --- | --- |
| Segmentation + tracking | SAM 3 with text prompts ("car", "person", "bicycle") on Modal | YOLO11-seg + ByteTrack, runs on a laptop GPU or CPU |
| Contours | OpenCV `findContours` + `approxPolyDP`, simplified to ≤ 48 points per frame | Bounding boxes only |
| Stats | Python, pandas, shapely (distances, zones) | Same |
| Backend | FastAPI, data loaded in memory at startup | Static JSON + client-side queries |
| Agent | LLM with tool calling (Claude), cached answers for demo queries | Hard-coded query buttons |
| Viewer | three.js (or react-three-fiber), Vite | Same |

**Data model**

One record per track in `tubes.json`. Contours are per frame, in pixel coordinates, and z is the frame index.

```json
{
  "video": {"id": "piedmont-decatur-01", "fps": 30, "width": 1920, "height": 1080, "frames": 3600},
  "tracks": [
    {
      "id": 14,
      "class": "car",
      "first_frame": 120,
      "last_frame": 410,
      "frames": [
        {"f": 120, "bbox": [812, 540, 1010, 660], "centroid": [911, 600], "contour": [[812, 600], [830, 552]]}
      ]
    }
  ]
}
```

Derived per-frame stats live in `stats.parquet`, one row per track per frame: `track_id, f, t_sec, cx, cy, vx, vy, speed, in_zone_ids`. A second table, `pairs.parquet`, holds person-vehicle pairs within a distance threshold: `a, b, f, dist, rel_speed`. Near-miss ranking reads only this table.

**Near-miss score (v1)**

For each person-vehicle pair, take the frame of minimum distance. Score = vehicle speed at that frame divided by min distance, with distance in pixels, or meters once the P1 homography is in place. Keep pairs where the distance is under a threshold and the vehicle is moving. This is a simplified time-to-collision proxy. Real safety studies use post-encroachment time (PET), a good P1 upgrade.

## Query agent

The LLM never sees raw contours. It plans a query, calls geometry tools over the stats tables, and returns a highlight set. The viewer renders that set. Code does the math, so answers are exact and checkable.

**Tools**

| Tool | Arguments | Returns |
| --- | --- | --- |
| `filter_tracks` | class, min/max speed, min duration, time range | track IDs |
| `near` | class_a, class_b, max_dist, moving_only | pairs with frame ranges and min distance |
| `in_zone` | zone_id, track IDs, min_dwell_sec | track IDs with entry/exit frames |
| `stopped` | track IDs, min_sec, zone_id (optional) | track IDs with stop intervals |
| `rank_near_misses` | top_k, time range | scored pairs, highest first |
| `count` | any result set, group_by (class, minute) | counts |
| `highlight` | result set, color, caption | the payload the viewer renders |

**Response contract**

Every answer ends with one `highlight` call. The viewer receives `{segments: [{track_id, f_start, f_end, color}], list: [{label, f, score}], caption}` and the agent's one-sentence summary. Click a list item to move the frame plane to `f`.

**Example queries**

| Question | Tool plan |
| --- | --- |
| Every time a person and a car got close | `near(person, car, 80px, moving_only)` → `highlight` |
| Which cars stopped in the crosswalk | `filter_tracks(car)` → `stopped(min 1s, zone=crosswalk)` → `highlight` |
| Top 3 most dangerous moments | `rank_near_misses(3)` → `highlight` |
| How many people crossed per minute | `filter_tracks(person)` → `in_zone(crosswalk)` → `count(minute)` |
| Fastest car in the clip | `filter_tracks(car)` sorted by max speed, top 1 → `highlight` |

For the demo, cache the agent's results for these five questions keyed by normalized text. A live call still runs, but a cache hit returns instantly if Wi-Fi is slow.

## Viewer UX spec

The look follows the three reference videos: the dark contour cube (default), the light cutout-tube intersection view (P1 mode), and the dark film-archive strips with semantic search (P2 archive view). See `reference/`.

**Layout**

- Full-screen 3D canvas, dark background, cube angled about 30° so time recedes to the right.
- Search bar centered at the bottom, pill-shaped, as in the reference. It accepts both class words and full questions; anything over two words goes to the agent.
- Results panel on the right, collapsible: agent summary sentence, then the ranked list (label, timestamp, score).
- Small video player in the top-left corner, synced to the frame plane.

**Cube rendering**

- Each track's contours are `THREE.LineLoop`s at z = frame × spacing. Draw every Nth frame (N = 3 to 5) to keep line count down; merge all loops of one track into one `LineSegments` geometry with a per-vertex alpha.
- Colors by track from a fixed palette. On search: matched tubes at full opacity, everything else at 8%.
- Video volume: a stack of 30 to 60 semi-transparent frame textures, desaturated, so the scene reads faintly behind the tubes.
- Highlighted segments (agent results) draw in red with thicker lines, only between `f_start` and `f_end`.

**Frame plane**

- Textured plane showing the current frame, with a diamond handle on top (as in the reference). Drag along z to scrub.
- Contours at the plane's frame are drawn on the plane itself, so the slice and the video line up.

**Zones (P1)**

- "Draw zone" button, click points on the frame plane, double-click to close. Name it inline ("crosswalk").
- Zone renders as a translucent prism along the full time axis. Tubes that pierce it get a small entry marker.

**Cutout mode and callouts (P1)**

- Toggle swaps contour loops for stacked sprite cutouts (frame crop masked by the object mask), giving the textured tubes from the light reference.
- Each highlighted track gets a floating thumbnail beside the cube, linked to its tube by a dotted line.

## Build plan

About 20 working hours, in four phases. Each gate is a hard check: if it fails, take the fallback and keep moving.

(The original doc embedded a build-plan diagram: 4 phases, 3 go/no-go gates.)

The viewer can start in parallel during phase 1 with a fake `tubes.json` of a few synthetic tracks, so the pipeline never blocks frontend work.

## Risks and fallbacks

| Risk | Likelihood | Fallback |
| --- | --- | --- |
| SAM 3 setup or Modal cold starts eat hours | Medium | Switch to YOLO11-seg + ByteTrack at the first checkpoint; same output schema |
| Footage has too few interactions for a near-miss demo | High | Film at a busy crossing at rush hour; else use a public fixed-camera clip with clear licensing |
| Track IDs switch mid-tube (occlusion, crowds) | High | Shorter clip, higher camera angle; stitch tracks whose end and start are close in space and time |
| Viewer slows with thousands of line loops | Medium | Draw every 5th frame, merge geometry per track, cap at 2,000 frames |
| LLM picks wrong tools or is slow on venue Wi-Fi | Medium | Cached answers for the 5 demo questions; buttons for them as a last resort |
| Pixel distances make "close" mean different things near and far from camera | High | Accept for v1; P1 homography fixes it. Say so if judges ask |
| Privacy questions from judges | Medium | Outlines only, no faces or plates stored, no re-ID; frames can be blurred |

## Success metrics

- All 5 demo questions return correct highlights. Check each by scrubbing to the returned frames.
- At least 3 real near misses in the footage, and all 3 appear in the top 5 of the ranking.
- Search highlight in under 100ms; agent answer in under 5s live, instant from cache.
- Viewer holds 60fps on the demo laptop with the full clip loaded.
- The full demo runs with Wi-Fi off.

## Demo and launch video

**Devpost video (2 to 2.5 min).** The demo scenario above, tightened: problem B-roll of the tripod at the intersection (15s), product screen recording of steps 2 to 6 (75s), one architecture diagram (20s), safety pitch (20s). Record with Screen Studio or OBS at 1080p60, browser full screen. Record the voiceover separately from a script and cut the footage to it.

**Launch video for X (30 to 45s).** Open on the cube already spinning with tubes lit, no title card. One wow moment: type the near-miss question, red segments light up. Big text overlays and music so it works muted. End on the name and link. Post with "built in 36 hours at Hacklanta" and a thread with the architecture diagram and a zone-prism GIF.

## Open questions

- [ ] Which intersection, and when to film it for enough pedestrian traffic?
- [ ] When is the Hacklanta submission deadline, and when are judging slots?
- [ ] Team split: who owns the pipeline, the viewer, and the agent?
- [ ] Is the product name Tubewatch, or something else?
