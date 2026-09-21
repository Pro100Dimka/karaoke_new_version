from __future__ import annotations

import math
import struct
import wave
from pathlib import Path

from backend.ai.domain import PitchPoint
from backend.domain_errors import DomainError


class WavePitchExtractor:
    def __init__(self, window_seconds: float = 0.05) -> None:
        self._window_seconds = window_seconds

    def extract(self, path: Path) -> tuple[PitchPoint, ...]:
        try:
            with wave.open(str(path), "rb") as audio:
                if audio.getsampwidth() != 2:
                    raise DomainError(
                        "AnalysisFailed", "Only 16-bit PCM recordings are supported", 422
                    )
                rate = audio.getframerate()
                channels = audio.getnchannels()
                frames = audio.readframes(audio.getnframes())
        except (OSError, EOFError, wave.Error) as exc:
            raise DomainError("AnalysisFailed", "Recording audio cannot be decoded", 422) from exc
        samples = _first_channel(frames, channels)
        window = max(64, int(rate * self._window_seconds))
        return tuple(
            _pitch(samples[index : index + window], rate, index / rate)
            for index in range(0, len(samples), window)
        )


def _first_channel(raw: bytes, channels: int) -> tuple[int, ...]:
    if channels <= 0:
        raise DomainError("AnalysisFailed", "Recording channel count is invalid", 422)
    count = len(raw) // 2
    values = struct.unpack(f"<{count}h", raw)
    return tuple(values[index] for index in range(0, len(values), channels))


def _pitch(samples: tuple[int, ...], rate: int, time: float) -> PitchPoint:
    if len(samples) < 2:
        return PitchPoint(time, 0.0, 0.0)
    peak = max(abs(value) for value in samples)
    if peak < 200:
        return PitchPoint(time, 0.0, 0.0)
    crossings = sum(
        1 for left, right in zip(samples, samples[1:], strict=False) if left <= 0 < right
    )
    duration = len(samples) / rate
    frequency = crossings / duration if duration > 0 else 0.0
    if not 50.0 <= frequency <= 1400.0 or not math.isfinite(frequency):
        return PitchPoint(time, 0.0, 0.0)
    confidence = min(1.0, peak / 8000.0)
    return PitchPoint(time, frequency, confidence)
