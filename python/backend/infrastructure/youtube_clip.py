from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from threading import Event

from backend.domain_errors import DomainError
from backend.infrastructure.process_runner import ProcessRunner

_YOUTUBE_ID = re.compile(
    r"(?:youtu\.be/|youtube(?:-nocookie)?\.com/(?:watch\?(?:[^#]*&)?v=|embed/|shorts/|live/))"
    r"([A-Za-z0-9_-]{11})",
    re.IGNORECASE,
)


class YoutubeClipDownloader:
    """Downloads the recognized clip and publishes a browser-compatible silent MP4."""

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
            if source is None or not self._transcode_mp4(
                source, temporary, expected_duration, cancel
            ):
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
                "yt_dlp",
                *self._options(directory / ".clip-download.%(ext)s"),
                f"https://www.youtube.com/watch?v={video_id}",
            ],
            timeout_seconds=1800,
            cancel=cancel,
        )
        candidates = [
            path
            for path in directory.glob(".clip-download.*")
            if path.is_file() and path.suffix not in {".part", ".ytdl"}
        ]
        if result.exit_code != 0 or not candidates:
            return None
        return max(candidates, key=lambda path: path.stat().st_size)

    @staticmethod
    def _options(template: Path) -> list[str]:
        return [
            "--ignore-config",
            "--no-cache-dir",
            "--no-playlist",
            "--quiet",
            "--no-warnings",
            "--no-progress",
            "--js-runtimes",
            "node",
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
                "bestvideo[vcodec^=avc1][ext=mp4][height>=720][height<=1080]/"
                "bestvideo[ext=mp4][height>=720][height<=1080]/"
                "bestvideo[height>=720][height<=1080]/bestvideo/best"
            ),
        ]

    def _transcode_mp4(
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
                "-an",
                "-sn",
                "-dn",
                "-vf",
                "scale='min(1920,iw)':-2",
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-crf",
                "20",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                str(destination),
            ],
            timeout_seconds=timeout,
            cancel=cancel,
        )
        return result.exit_code == 0 and destination.is_file() and destination.stat().st_size > 0

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
