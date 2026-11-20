"""Offline, opt-in developer CLI for pinned Audiobox comparison manifests."""

from __future__ import annotations

import argparse
from collections.abc import Sequence
import json
from pathlib import Path
import sys

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.audio_quality.contracts import load_plan
from scripts.audio_quality.model import (
    LocalPredictor,
    verify_artifacts,
    verify_artifacts_unchanged,
)
from scripts.audio_quality.runner import score_plan


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source-dir", "model-dir", "manifest", "mapping", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument(
        "--manifest-sha256", required=True, help="Previously frozen manifest SHA256"
    )
    parser.add_argument(
        "--threads", type=int, default=2, help="Explicit CPU thread budget (default: 2)"
    )
    return parser


def _run(args: argparse.Namespace) -> dict[str, object]:
    if args.output.exists() or args.output.suffix.lower() != ".json":
        raise ValueError("Output must be a new .json file; existing files are never overwritten")
    if args.threads < 1:
        raise ValueError("threads must be positive")
    plan = load_plan(args.manifest, args.mapping, args.manifest_sha256)
    assets = verify_artifacts(args.source_dir, args.model_dir)
    predictor = LocalPredictor(assets, args.threads)
    result = score_plan(plan, predictor, predictor.provenance)
    verify_artifacts_unchanged(assets)
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")
    return result


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        result = _run(args)
    except (ValueError, OSError, RuntimeError, ImportError) as exc:
        print(f"Audio-quality audit failed: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({"output": str(args.output), "elapsedSeconds": result["elapsedSeconds"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
