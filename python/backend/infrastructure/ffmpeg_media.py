from __future__ import annotations

from pathlib import Path
from dataclasses import replace
from functools import lru_cache
import numpy as np

from backend.domain_errors import DomainError
from backend.infrastructure.process_runner import ProcessRunner
from backend.projects.content_lock import KeyedLockManager
from backend.serialization import loads_object
from backend.songs.ports import MediaMetadata
from backend.lyrics.ports import SidecarLyricsReader


class FfmpegMediaInspector:
    def __init__(
        self,
        runner: ProcessRunner,
        ffprobe: str = "ffprobe",
        ffmpeg: str = "ffmpeg",
        *,
        sidecar: SidecarLyricsReader | None = None,
    ) -> None:
        self._runner = runner
        self._ffprobe = ffprobe
        self._ffmpeg = ffmpeg
        self._sidecar = sidecar
        self._waveform_locks = KeyedLockManager()

    def waveform_peaks(self, source: Path, bins: int) -> list[float]:
        source = source.resolve()
        with self._waveform_locks.acquire(str(source)):
            stat = source.stat()
            return list(self._waveform(source, bins, stat.st_mtime_ns, stat.st_size))

    @lru_cache(maxsize=256)
    def _waveform(self, source: Path, bins: int, _mtime: int, _size: int) -> tuple[float, ...]:
        result = self._runner.run(
            [
                self._ffmpeg,
                "-v",
                "error",
                "-i",
                str(source),
                "-vn",
                "-ac",
                "1",
                "-ar",
                "2000",
                "-f",
                "f32le",
                "pipe:1",
            ],
            timeout_seconds=60,
        )
        if result.exit_code != 0:
            raise DomainError("InvalidMedia", "Song waveform could not be read", 400)
        samples = np.frombuffer(result.stdout, dtype="<f4")
        peaks = np.zeros(bins)
        slots = np.arange(samples.size) * bins // max(1, samples.size)
        np.maximum.at(peaks, slots, np.nan_to_num(np.abs(samples), nan=0, posinf=0, neginf=0))
        maximum = float(peaks.max()) or 1
        return tuple(round(float(value) / maximum, 3) for value in peaks)

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
            metadata = self._metadata(payload, source)
        except (UnicodeDecodeError, ValueError, TypeError) as exc:
            raise DomainError("InvalidMedia", "Media metadata is malformed", 400) from exc
        if metadata.duration is None or metadata.duration <= 0:
            self._require_audio_samples(source)
        lyrics = self._sidecar.read(source) if self._sidecar is not None else None
        return replace(metadata, embedded_lyrics=lyrics) if lyrics else metadata

    def _require_audio_samples(self, source: Path) -> None:
        result = self._runner.run(
            [
                self._ffmpeg,
                "-v",
                "error",
                "-i",
                str(source),
                "-map",
                "0:a:0",
                "-frames:a",
                "1",
                "-f",
                "f32le",
                "pipe:1",
            ],
            timeout_seconds=15,
        )
        if result.exit_code != 0 or not result.stdout:
            raise DomainError("InvalidMedia", "Selected file has no readable audio samples", 400)

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
        tags = [format_data.get("tags")]
        streams = payload.get("streams")
        if isinstance(streams, list):
            for stream in streams:
                if isinstance(stream, dict) and stream.get("codec_type") == "audio":
                    tags.append(stream.get("tags"))
                    break
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
            embedded_lyrics=_tag(tags, "lyrics", "unsyncedlyrics"),
            has_embedded_artwork=has_artwork,
        )


def _tag(sources: list[object], *keys: str) -> str | None:
    # Container tags take precedence; Ogg/Opus store theirs on the audio stream.
    for tags in sources:
        if not isinstance(tags, dict):
            continue
        for key in keys:
            values = [tags.get(key), tags.get(key.upper())]
            values.extend(
                value
                for name, value in tags.items()
                if isinstance(name, str) and name.casefold() == key
            )
            for value in values:
                if isinstance(value, str) and value.strip():
                    return value.strip()
    return None


def _optional_float(value: object) -> float | None:
    if not isinstance(value, (str, int, float)):
        return None
    try:
        return float(value)
    except ValueError:
        return None
