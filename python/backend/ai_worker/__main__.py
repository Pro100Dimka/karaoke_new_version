from __future__ import annotations

import argparse
import sys
from collections.abc import Mapping
from pathlib import Path

from backend.ai_worker.speech import align, prepare_accelerator, transcribe
from backend.serialization import dumps, loads_list, loads_object


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="backend.ai_worker")
    actions = parser.add_subparsers(dest="action", required=True)
    actions.add_parser("prepare-accelerator")
    separate_action = actions.add_parser("separate")
    separate_action.add_argument("--input", type=Path, required=True)
    separate_action.add_argument("--output", type=Path, required=True)
    transcribe_action = actions.add_parser("transcribe")
    transcribe_action.add_argument("--input", type=Path, required=True)
    transcribe_action.add_argument("--language", default="Auto")
    transcribe_action.add_argument("--start-seconds", type=float, default=0.0)
    align_action = actions.add_parser("align")
    align_action.add_argument("--input", type=Path, required=True)
    align_action.add_argument("--language", default="Auto")
    align_action.add_argument("--lyrics", required=True)
    align_action.add_argument("--timing-hints")
    align_action.add_argument("--instrumental", type=Path)
    align_action.add_argument("--recognition-stdin", action="store_true")
    pitch_action = actions.add_parser("pitch")
    pitch_action.add_argument("--input", type=Path, required=True)
    return parser


def _run(args: argparse.Namespace) -> Mapping[str, object]:
    if args.action == "prepare-accelerator":
        return prepare_accelerator()
    if args.action == "separate":
        from backend.ai_worker.separation import separate

        return separate(args.input, args.output)
    if args.action == "transcribe":
        return transcribe(args.input, args.language, start_seconds=args.start_seconds)
    if args.action == "align":
        hints = loads_list(args.timing_hints) if args.timing_hints else []
        recognition = (
            loads_object(sys.stdin.buffer.read().decode("utf-8"))
            if args.recognition_stdin
            else None
        )
        return align(
            args.input,
            args.lyrics,
            args.language,
            hints,
            instrumental=args.instrumental,
            recognition=recognition,
        )
    from backend.ai_worker.pitch import pitch

    return pitch(args.input)


def main(argv: list[str]) -> int:
    # The backend decodes stdout as UTF-8 regardless of the console code page.
    sys.stdout.buffer.write(dumps(_run(_parser().parse_args(argv))).encode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
