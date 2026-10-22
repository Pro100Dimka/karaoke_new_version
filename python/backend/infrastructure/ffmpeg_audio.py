from __future__ import annotations

import threading
import math
import re
from pathlib import Path

from backend.domain_errors import DependencyError, DomainError
from backend.infrastructure.process_runner import ProcessResult, ProcessRunner
from backend.serialization import loads_object


def loudnorm_filter(measured: dict[str, float] | None = None, *, lra: int = 7) -> str:
    settings = f"loudnorm=I=-14:LRA={lra}:TP=-1"
    if measured is None:
        return settings + ":print_format=json"
    ranges = {
        "input_i": (-99, 0), "input_lra": (0, 99), "input_tp": (-99, 99),
        "input_thresh": (-99, 0), "target_offset": (-99, 99),
    }
    if not all(
        math.isfinite(measured[key]) and low <= measured[key] <= high
        for key, (low, high) in ranges.items()
    ):
        return settings
    return (
        settings + ":linear=true:"
        f"measured_I={measured['input_i']}:measured_LRA={measured['input_lra']}:"
        f"measured_TP={measured['input_tp']}:measured_thresh={measured['input_thresh']}:"
        f"offset={measured['target_offset']}"
    )


def parse_loudness(stderr: bytes) -> dict[str, float] | None:
    match = re.search(rb'\{\s*"input_i".*?\}', stderr, re.DOTALL)
    if match is None:
        return None
    try:
        payload = loads_object(match.group(0).decode("utf-8"))
        keys = ("input_i", "input_lra", "input_tp", "input_thresh", "target_offset")
        return {key: float(payload[key]) for key in keys}
    except (KeyError, TypeError, ValueError, UnicodeDecodeError):
        return None


class FfmpegAudioValidator:
    def __init__(self, runner: ProcessRunner, ffprobe: str = "ffprobe") -> None:
        self._runner = runner
        self._ffprobe = ffprobe

    def validate(self, path: Path) -> None:
        result = self._runner.run(
            [
                self._ffprobe,
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=codec_name",
                "-of",
                "csv=p=0",
                str(path),
            ],
            timeout_seconds=10,
        )
        if result.exit_code != 0 or not result.stdout.strip():
            raise DomainError(
                "ProjectInvalid", "Audio artifact is not readable", 400, {"path": str(path)}
            )


class FfmpegAudioNormalizer:
    def __init__(self, runner: ProcessRunner, ffmpeg: str = "ffmpeg") -> None:
        self._runner = runner
        self._ffmpeg = ffmpeg

    def normalize(
        self, source: Path, target: Path, *, threads: int, cancel: threading.Event
    ) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        analysis = self._run(
            source, loudnorm_filter(lra=11), ["-f", "null", "-"], threads, cancel, quiet=False
        )
        measured = parse_loudness(analysis.stderr) if analysis.exit_code == 0 else None
        if measured is None:
            raise DependencyError("ProcessingFailed", "FFmpeg loudness analysis failed")
        result = self._run(
            source, loudnorm_filter(measured, lra=11),
            ["-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", str(target)],
            threads, cancel, quiet=True,
        )
        if result.exit_code != 0:
            raise DependencyError("ProcessingFailed", "FFmpeg normalization failed")

    def _run(
        self, source: Path, audio_filter: str, output: list[str], threads: int,
        cancel: threading.Event, *, quiet: bool,
    ) -> ProcessResult:
        return self._runner.run(
            [
                self._ffmpeg,
                "-v",
                "error" if quiet else "info",
                "-nostats",
                "-y",
                "-i",
                str(source),
                "-vn",
                "-af",
                audio_filter,
                "-threads",
                str(threads),
                *output,
            ],
            timeout_seconds=300,
            cancel=cancel,
        )
