from __future__ import annotations

import threading
from pathlib import Path

from backend.domain_errors import DependencyError, DomainError
from backend.infrastructure.process_runner import ProcessRunner


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
        result = self._runner.run(
            [
                self._ffmpeg,
                "-v",
                "error",
                "-y",
                "-i",
                str(source),
                "-vn",
                "-ar",
                "44100",
                "-ac",
                "2",
                "-c:a",
                "pcm_s16le",
                "-threads",
                str(threads),
                str(target),
            ],
            timeout_seconds=300,
            cancel=cancel,
        )
        if result.exit_code != 0:
            raise DependencyError("ProcessingFailed", "FFmpeg normalization failed")
