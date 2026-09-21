from __future__ import annotations

import argparse
import sys
from collections.abc import Mapping
from pathlib import Path

from backend.ai_worker.pitch import pitch
from backend.ai_worker.separation import separate
from backend.ai_worker.speech import align, transcribe
from backend.serialization import dumps


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="backend.ai_worker")
    actions = parser.add_subparsers(dest="action", required=True)
    separate_action = actions.add_parser("separate")
    separate_action.add_argument("--input", type=Path, required=True)
    separate_action.add_argument("--output", type=Path, required=True)
    transcribe_action = actions.add_parser("transcribe")
    transcribe_action.add_argument("--input", type=Path, required=True)
    transcribe_action.add_argument("--language", default="Auto")
    align_action = actions.add_parser("align")
    align_action.add_argument("--input", type=Path, required=True)
    align_action.add_argument("--language", default="Auto")
    align_action.add_argument("--lyrics", required=True)
    pitch_action = actions.add_parser("pitch")
    pitch_action.add_argument("--input", type=Path, required=True)
    return parser


def _run(args: argparse.Namespace) -> Mapping[str, object]:
    if args.action == "separate":
        return separate(args.input, args.output)
    if args.action == "transcribe":
        return transcribe(args.input, args.language)
    if args.action == "align":
        return align(args.input, args.lyrics)
    return pitch(args.input)


def main(argv: list[str]) -> int:
    # The backend decodes stdout as UTF-8 regardless of the console code page.
    sys.stdout.buffer.write(dumps(_run(_parser().parse_args(argv))).encode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
