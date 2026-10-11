# Build decisions

Oct 10, 2026. These override the PRD where they conflict.

1. **Data.** The viewer is built first against a synthetic `tubes.json` (plus matching stats/pairs). The pipeline is proven end to end on a public fixed-camera intersection clip with clear licensing. GSU footage gets swapped in later.
2. **Stack.** Vite + react-three-fiber viewer, FastAPI backend (data in memory, geometry tools in pandas/shapely), Python pipeline.
3. **Segmentation.** SAM 3 with text prompts ("car", "person", "bicycle") on Modal GPUs. Superseded on Oct 10: originally YOLO11-seg + ByteTrack on the Mac. YOLO stays as a local fallback when Modal is unreachable.
4. **Scope.** All P0 features. Zone drawing (P1) was built and then removed on Oct 11 because it isn't useful; preset crosswalk zones stay server-side for the crosswalk questions. Out of scope: synopsis export, cutout mode, callouts, homography, everything P2.
5. **Agent.** Claude Sonnet 5.5 (`claude-sonnet-5-5`) with tool calling. The 5 demo questions are cached to disk, keyed by normalized text. Offline mode serves only cached answers.

6. **Idle shows only the video.** With no search or question, the cube shows the video volume and frame plane only, with no tubes (`reference/idle-volume.png`). The volume is clearly visible, like a smoky block of the footage. Tubes appear only for what was searched or asked: "car" shows car tubes, and a question shows its matched tracks (`reference/search-car.png`). Clearing the search returns to the video-only view.
7. **Usable app with uploads.** Users upload a video in the viewer and get the cube back. The viewer and FastAPI run locally, and only SAM 3 runs on Modal. There is a library of videos, with the built-in datasets plus uploads. Contract: docs/api.md v2.
8. **Speed target.** A 1-minute clip is ready in about 1 minute. SAM 3 runs at about 10 fps on downscaled frames, in chunks across 2 to 4 GPUs in parallel, with tracks stitched at chunk overlaps. The GPU container is warmed when the app opens and when a file is picked, and isn't kept warm otherwise. Thumbnails and the volume are built while the GPU works. Tubes stream into the viewer as chunks finish.
9. **Upload limit.** 2 minutes. Longer uploads are trimmed, with a notice.
10. **Near-miss geometry.** Distances use ground contact points (the bottom center of each mask), and occluded overlaps are skipped. A ground-plane homography stays P1.

Reference images: `reference/idle-volume.png` (idle state), `reference/search-car.png` and `reference/contour-cube.png` (search state), `reference/archive-strips.png` (P2 archive view, look only).

11. **Name.** The product is called **Tube** (Oct 11), not Tubewatch. Internal identifiers keep the old name: the repo folder, the Modal app `tubewatch-sam3` and its Volume, env vars and storage keys.
12. **Archive search.** vidsearch's Traffic Archive (semantic search over traffic clips drawn as filmstrips) is part of Tube at `/archive`, next to the cube at `/app` and the landing page at `/`. It keeps its own look and behavior and talks straight to vidsearch's Modal deployment (`VITE_ARCHIVE_API`), so it also works in the static demo. Each route lazy-loads only its own stylesheet; moving between the cube and the archive is a full page load.
