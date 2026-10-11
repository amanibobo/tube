# Tube

Space-time search for traffic video. Tube turns a fixed-camera clip into a 3D cube where every car, person and bike is a tube through time. You can then search it in plain English: ask "every time a person and a car got close", and the matching moments light up in the cube, ranked, one click from the video.

![Tube architecture](docs/architecture.png)

## How it works

1. **Prepare.** ffmpeg normalizes the upload (at most 1280x720 and 120 s) and cuts thumbnails, so the cube and frame plane show up while the rest runs.
2. **Segment.** SAM 3 runs on Modal, splitting the clip into chunks across up to 4 H100s in parallel, with text prompts for vehicles, people and bicycles. If Modal isn't available, YOLO11-seg with ByteTrack runs on the local machine instead.
3. **Build tubes.** OpenCV turns each mask into a contour per frame. pandas and shapely compute speeds, ground contact points and close passes between people and vehicles.
4. **Ask.** Claude Sonnet 5.5 plans geometry tool calls (`near`, `stopped`, `in_zone`, `rank_near_misses`, …). The tools do the math, so every answer is exact and you can check it frame by frame.

With the GPUs warm, a one-minute clip is ready in about 50 seconds. Tubes stream into the viewer as chunks finish.

## Run it

You need Python 3.12+, Node 22 and ffmpeg.

```sh
# server
uv venv && uv pip install -r requirements.txt
ANTHROPIC_API_KEY=... .venv/bin/uvicorn server.main:app --port 8000

# viewer (in another terminal)
cd viewer && npm install && npm run dev   # http://localhost:5180
```

The landing page is at `/` and the app at `/app`. Without an API key, the server runs offline and answers the five demo questions from its cache. The repo ships a synthetic clip only. See `docs/data-sources.md` to fetch the real demo clips, or upload your own.

### SAM 3 on Modal (optional)

```sh
modal secret create huggingface HF_TOKEN=hf_...   # after accepting the facebook/sam3 license
modal deploy -m pipeline.sam3_modal
```

Uploads then use SAM 3 automatically. To process a clip from the command line:

```sh
python -m pipeline.ingest clip.mp4 --out data/my-clip --backend auto   # or sam3, yolo
```

## Layout

| Path | What's there |
| --- | --- |
| `viewer/` | Vite, React, three.js and react-three-fiber: the landing page, the cube, search and upload |
| `server/` | FastAPI: the video library, upload jobs, geometry tools and the Claude agent |
| `pipeline/` | ffmpeg, SAM 3 (Modal) and YOLO segmentation, contours, stats |
| `docs/` | The PRD, build decisions, API contract, data sources and architecture diagram (`.excalidraw`) |
| `tests/` | `pytest`: tools, the upload flow, chunk stitching and geometry |

## Credits

Logos in the diagram are from Simple Icons. Clip credits and licenses are in `docs/data-sources.md`.
