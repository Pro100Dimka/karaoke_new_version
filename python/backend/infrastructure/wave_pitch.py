from __future__ import annotations

import wave
from pathlib import Path

import numpy as np

from backend.ai.domain import PitchPoint
from backend.domain_errors import DomainError

# Windows read per block: memory stays bounded by this many windows of audio whatever the length
# of the take (a whole take used to be unpacked into Python integers and ran out of memory).
_WINDOWS_PER_BLOCK = 512
_SILENCE_PEAK = 200
_LOWEST_HZ = 50.0
_HIGHEST_HZ = 1400.0
_FULL_CONFIDENCE_PEAK = 8000.0


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
                channels = audio.getnchannels()
                if channels <= 0:
                    raise DomainError("AnalysisFailed", "Recording channel count is invalid", 422)
                rate = audio.getframerate()
                window = max(64, int(rate * self._window_seconds))
                points: list[PitchPoint] = []
                start = 0
                while block := audio.readframes(window * _WINDOWS_PER_BLOCK):
                    samples = np.frombuffer(block, dtype="<i2")[::channels]
                    points.extend(_block_pitch(samples, rate, window, start))
                    start += len(samples)
        except (OSError, EOFError, wave.Error) as exc:
            raise DomainError("AnalysisFailed", "Recording audio cannot be decoded", 422) from exc
        return tuple(points)


def _block_pitch(samples: np.ndarray, rate: int, window: int, start: int) -> list[PitchPoint]:
    """One point per window: the zero-crossing frequency of the first channel."""
    points: list[PitchPoint] = []
    for offset in range(0, len(samples), window):
        chunk = samples[offset : offset + window].astype(np.int32)
        time = (start + offset) / rate
        if len(chunk) < 2:
            points.append(PitchPoint(time, 0.0, 0.0))
            continue
        peak = int(np.abs(chunk).max())
        if peak < _SILENCE_PEAK:
            points.append(PitchPoint(time, 0.0, 0.0))
            continue
        crossings = int(np.count_nonzero((chunk[:-1] <= 0) & (chunk[1:] > 0)))
        frequency = crossings / (len(chunk) / rate)
        if not _LOWEST_HZ <= frequency <= _HIGHEST_HZ:
            points.append(PitchPoint(time, 0.0, 0.0))
            continue
        points.append(PitchPoint(time, frequency, min(1.0, peak / _FULL_CONFIDENCE_PEAK)))
    return points
