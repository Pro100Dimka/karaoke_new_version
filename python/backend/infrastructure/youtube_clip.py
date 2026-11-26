from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from threading import Event

from backend.domain_errors import DomainError
from backend.infrastructure.process_runner import ProcessRunner
from backend.serialization import loads_object

_YOUTUBE_ID = re.compile(
    r"(?:youtu\.be/|youtube(?:-nocookie)?\.com/(?:watch\?(?:[^#]*&)?v=|embed/|shorts/|live/))"
    r"([A-Za-z0-9_-]{11})",
    re.IGNORECASE,
)


class YoutubeClipDownloader:
    """Downloads complete audio/video and remuxes MP4 without changing the media."""

    def __init__(
        self,
        *,
        processes: ProcessRunner | None = None,
    ) -> None:
        self._processes = processes or ProcessRunner()

    def download(
        self,
        source_url: str,
        destination: Path,
        *,
        expected_duration: float | None,
        cancel: Event | None = None,
    ) -> bool:
        match = _YOUTUBE_ID.search(source_url)
        if match is None:
            return False
        video_id = match.group(1)
        destination.parent.mkdir(parents=True, exist_ok=True)
        self._cleanup(destination.parent)
        temporary = destination.with_name(f".{destination.stem}.tmp{destination.suffix}")
        temporary.unlink(missing_ok=True)
        try:
            source = self._download_source(video_id, destination.parent, cancel)
            if source is None or not self._remux_mp4(source, temporary, expected_duration, cancel):
                return False
            if not self._has_motion(temporary, cancel) or (cancel is not None and cancel.is_set()):
                return False
            os.replace(temporary, destination)
            return destination.is_file() and destination.stat().st_size > 0
        except (OSError, RuntimeError, ValueError, DomainError):
            return False
        finally:
            temporary.unlink(missing_ok=True)
            self._cleanup(destination.parent)

    def _download_source(self, video_id: str, directory: Path, cancel: Event | None) -> Path | None:
        result = self._processes.run(
            [
                sys.executable,
                "-m",
                "backend.infrastructure.youtube_access",
                *self._options(directory / ".clip-download.%(ext)s"),
                f"https://www.youtube.com/watch?v={video_id}",
            ],
            timeout_seconds=1800,
            cancel=cancel,
        )
        source = directory / ".clip-download.mp4"
        return source if result.exit_code == 0 and source.is_file() else None

    @staticmethod
    def _options(template: Path) -> list[str]:
        return [
            "--ignore-config",
            "--no-cache-dir",
            "--no-playlist",
            "--quiet",
            "--no-warnings",
            "--no-progress",
            "--no-js-runtimes",
            "--no-plugin-dirs",
            "--http-chunk-size",
            "1M",
            "--merge-output-format",
            "mp4",
            "--force-overwrites",
            "--continue",
            "--socket-timeout",
            "20",
            "--retries",
            "2",
            "--fragment-retries",
            "2",
            "--max-filesize",
            str(400 * 1024 * 1024),
            "--output",
            str(template),
            "--format",
            (
                "bestvideo[vcodec^=avc1][ext=mp4][height<=720][fps<=30][protocol=https]"
                "+bestaudio[ext=m4a][protocol=https]/"
                "best[ext=mp4][vcodec^=avc1][acodec!=none][height<=720][fps<=30][protocol=https]"
            ),
        ]

    def _remux_mp4(
        self, source: Path, destination: Path, expected_duration: float | None, cancel: Event | None
    ) -> bool:
        timeout = max(180.0, min(1800.0, (expected_duration or 300.0) * 4.0))
        result = self._processes.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-y",
                "-i",
                str(source),
                "-map",
                "0:v:0",
                "-map",
                "0:a:0",
                "-sn",
                "-dn",
                "-c",
                "copy",
                "-movflags",
                "+faststart",
                str(destination),
            ],
            timeout_seconds=timeout,
            cancel=cancel,
        )
        return result.exit_code == 0 and destination.is_file() and destination.stat().st_size > 0

    def is_complete(self, source: Path, cancel: Event | None = None) -> bool:
        if not source.is_file():
            return False
        result = self._processes.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type",
                "-of",
                "json",
                str(source),
            ],
            timeout_seconds=15,
            cancel=cancel,
        )
        try:
            streams = loads_object(result.stdout.decode("utf-8")).get("streams", [])
            if not isinstance(streams, list):
                return False
            kinds = {item.get("codec_type") for item in streams if isinstance(item, dict)}
            return result.exit_code == 0 and {"audio", "video"}.issubset(kinds)
        except (ValueError, UnicodeError):
            return False

    def _has_motion(self, source: Path, cancel: Event | None) -> bool:
        frame_size = 32 * 18
        result = self._processes.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-i",
                str(source),
                "-vf",
                "fps=0.2,scale=32:18,format=gray",
                "-frames:v",
                "24",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "gray",
                "pipe:1",
            ],
            timeout_seconds=60,
            cancel=cancel,
        )
        frames = [
            result.stdout[offset : offset + frame_size]
            for offset in range(0, len(result.stdout) - frame_size + 1, frame_size)
        ]
        changes = sum(
            _frame_difference(left, right) >= 3.5
            for left, right in zip(frames, frames[1:], strict=False)
        )
        return result.exit_code == 0 and len(frames) >= 4 and changes >= 3

    @staticmethod
    def _cleanup(directory: Path) -> None:
        for stale in directory.glob(".clip-download.*"):
            stale.unlink(missing_ok=True)


def _frame_difference(left: bytes, right: bytes) -> float:
    if not left:
        return 0.0
    return sum(abs(first - second) for first, second in zip(left, right, strict=True)) / len(left)
