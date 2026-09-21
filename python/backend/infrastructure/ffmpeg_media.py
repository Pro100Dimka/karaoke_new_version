from __future__ import annotations

from pathlib import Path

from backend.domain_errors import DomainError
from backend.infrastructure.process_runner import ProcessRunner
from backend.serialization import loads_object
from backend.songs.ports import MediaMetadata


class FfmpegMediaInspector:
    def __init__(
        self, runner: ProcessRunner, ffprobe: str = "ffprobe", ffmpeg: str = "ffmpeg"
    ) -> None:
        self._runner = runner
        self._ffprobe = ffprobe
        self._ffmpeg = ffmpeg

    def inspect(self, source: Path) -> MediaMetadata:
        result = self._runner.run(
            [
                self._ffprobe,
                "-v",
                "error",
                "-show_format",
                "-show_streams",
                "-of",
                "json",
                str(source),
            ],
            timeout_seconds=15,
        )
        if result.exit_code != 0:
            raise DomainError("InvalidMedia", "Selected file is not readable media", 400)
        try:
            payload = loads_object(result.stdout.decode("utf-8"))
            return self._metadata(payload, source)
        except (UnicodeDecodeError, ValueError, TypeError) as exc:
            raise DomainError("InvalidMedia", "Media metadata is malformed", 400) from exc

    def extract_artwork(self, source: Path, target: Path) -> bool:
        target.parent.mkdir(parents=True, exist_ok=True)
        result = self._runner.run(
            [
                self._ffmpeg,
                "-v",
                "error",
                "-y",
                "-i",
                str(source),
                "-an",
                "-map",
                "0:v:0?",
                "-frames:v",
                "1",
                str(target),
            ],
            timeout_seconds=20,
        )
        if result.exit_code == 0 and target.is_file() and target.stat().st_size:
            return True
        target.unlink(missing_ok=True)
        return False

    @staticmethod
    def _metadata(payload: dict[str, object], source: Path) -> MediaMetadata:
        format_data = payload.get("format")
        if not isinstance(format_data, dict):
            raise ValueError("ffprobe format missing")
        tags = format_data.get("tags")
        streams = payload.get("streams")
        has_artwork = isinstance(streams, list) and any(
            isinstance(stream, dict) and stream.get("codec_type") == "video" for stream in streams
        )
        duration = _optional_float(format_data.get("duration"))
        format_name = format_data.get("format_name")
        return MediaMetadata(
            title=_tag(tags, "title") or source.stem,
            artist=_tag(tags, "artist") or "Unknown Artist",
            album=_tag(tags, "album"),
            duration=duration,
            media_format=str(format_name) if format_name else source.suffix.lstrip("."),
            embedded_lyrics=_tag(tags, "lyrics") or _tag(tags, "unsyncedlyrics"),
            has_embedded_artwork=has_artwork,
        )


def _tag(tags: object, key: str) -> str | None:
    if not isinstance(tags, dict):
        return None
    value = tags.get(key) or tags.get(key.upper())
    return value.strip() if isinstance(value, str) and value.strip() else None


def _optional_float(value: object) -> float | None:
    if not isinstance(value, (str, int, float)):
        return None
    try:
        return float(value)
    except ValueError:
        return None
