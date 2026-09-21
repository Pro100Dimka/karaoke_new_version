from __future__ import annotations

import array
import wave
from pathlib import Path

from backend.domain_errors import DependencyError
from backend.processing.algorithms import MusicMetadata

_FRAME_RATE = 100
_MIN_BPM = 60
_MAX_BPM = 200


class WaveMusicAnalyzer:
    def analyze(self, audio: Path) -> MusicMetadata:
        try:
            envelope, sample_rate = _envelope(audio)
        except (OSError, wave.Error) as exc:
            raise DependencyError(
                "ProcessingFailed", "Normalized audio cannot be analyzed"
            ) from exc
        bpm = _estimate_bpm(envelope, sample_rate)
        return MusicMetadata(bpm=bpm, key="Unknown")


def _envelope(path: Path) -> tuple[list[float], int]:
    with wave.open(str(path), "rb") as stream:
        sample_rate = stream.getframerate()
        channels = stream.getnchannels()
        width = stream.getsampwidth()
        if width != 2:
            raise wave.Error("Music analyzer expects 16-bit PCM")
        samples = array.array("h", stream.readframes(stream.getnframes()))
    block = max(1, sample_rate * channels // _FRAME_RATE)
    values = [
        sum(abs(sample) for sample in samples[index : index + block]) / block
        for index in range(0, len(samples), block)
        if samples[index : index + block]
    ]
    return values, _FRAME_RATE


def _estimate_bpm(envelope: list[float], frame_rate: int) -> float | None:
    if len(envelope) < frame_rate * 3:
        return None
    onset = [
        max(0.0, current - previous)
        for previous, current in zip(envelope, envelope[1:], strict=False)
    ]
    min_lag = max(1, round(60 * frame_rate / _MAX_BPM))
    max_lag = max(min_lag, round(60 * frame_rate / _MIN_BPM))
    scores = {
        lag: sum(onset[index] * onset[index - lag] for index in range(lag, len(onset)))
        for lag in range(min_lag, min(max_lag, len(onset) - 1) + 1)
    }
    if not scores:
        return None
    best_lag = max(scores, key=lambda lag: scores[lag])
    return round(60.0 * frame_rate / best_lag, 2)
