"""Turn a video into a Tube dataset from the command line: the same four stages the upload job runs.

Run: python -m pipeline.ingest video.mp4 --out data/<id> [--backend auto|sam3|yolo] [--max-seconds 90]
     [--title "..."] [--credit "Video by Jane Doe, Pexels"]

--backend auto (default) uses SAM 3 on Modal when the app is deployed and reachable, else YOLO locally.
Hand-drawn zones in an existing data/<id>/zones.json are kept.
"""

import argparse
import os
from pathlib import Path

from pipeline import process


class PrintReporter:
    def stage(self, name: str, message: str) -> None:
        print(f"[{name}] {message}", flush=True)

    def progress(self, fraction: float) -> None:
        pass

    def tubes(self, frames_done: int, n_tracks: int) -> None:
        print(f"  {n_tracks} tracks through frame {frames_done}", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("video", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--backend", choices=["auto", "sam3", "yolo"], default="auto")
    ap.add_argument("--max-seconds", type=float, default=120)
    ap.add_argument("--title", default="")
    ap.add_argument("--credit", default="", help='shown in the viewer, e.g. "Video by Jane Doe, Pexels"')
    args = ap.parse_args()
    os.environ["TUBEWATCH_BACKEND"] = args.backend
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)
    process.write_meta(out, process.new_meta(
        out.name, args.title or out.name, "builtin", credit=args.credit, source_file=str(args.video.resolve()),
        keep_source=True, max_seconds=args.max_seconds))
    meta = process.run(out, PrintReporter())
    print(f"{meta['frames']} frames via {meta['backend']} -> {out}")


if __name__ == "__main__":
    main()
