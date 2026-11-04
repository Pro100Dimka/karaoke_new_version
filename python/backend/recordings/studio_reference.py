from __future__ import annotations
from pathlib import Path
import math
import threading
import numpy as np
from numpy.typing import NDArray
import soundfile as sf

from backend.recordings.studio_audio import _check_cancel


def _reference_offset(
    backing: Path,
    original: Path,
    origin: float | None,
    cancel: threading.Event,
) -> tuple[float, float]:
    # Match the SAME accompaniment, never two different singers. Tempo/key/seek changes
    # disable PCM matching; their explicit timeline mapping remains authoritative.
    if origin is None:
        return 0.0, 0.0
    duration = sf.info(backing).duration
    if duration < 8:
        return 0.0, 0.0
    rate = 4000
    margin = 0.25
    offsets, scores = [], []

    with sf.SoundFile(backing) as take, sf.SoundFile(original) as reference:
        for position in np.linspace(1, duration - 3, 3):
            _check_cancel(cancel)
            start = origin + position - margin
            if start < 0 or start + 2 + 2 * margin > reference.frames / reference.samplerate:
                continue
            actual = _read_reference(take, float(position), 2, rate)
            expected = _read_reference(reference, float(start), 2 + 2 * margin, rate)
            match = _reference_match(actual, expected)
            if match is None:
                continue
            peak, score = match
            offsets.append(peak / rate - margin)
            scores.append(score)
    if len(offsets) < 3 or np.ptp(offsets) > 0.002:
        return 0.0, 0.0
    return float(np.median(offsets)), min(scores)


def _read_reference(
    source: sf.SoundFile, start: float, seconds: float, rate: int
) -> NDArray[np.float64]:
    from scipy.signal import resample_poly

    source.seek(round(start * source.samplerate))
    samples = source.read(round(seconds * source.samplerate), always_2d=True).mean(axis=1)
    divisor = math.gcd(source.samplerate, rate)
    return np.asarray(
        resample_poly(samples, rate // divisor, source.samplerate // divisor),
        dtype=np.float64,
    )


def _reference_match(actual: np.ndarray, expected: np.ndarray) -> tuple[int, float] | None:
    from scipy.signal import correlate

    actual -= actual.mean()
    power = float(actual @ actual)
    if power < 1e-8 or len(expected) < len(actual):
        return None
    count = len(actual)
    sums = np.r_[0.0, np.cumsum(expected)]
    squares = np.r_[0.0, np.cumsum(expected * expected)]
    variance = squares[count:] - squares[:-count] - (sums[count:] - sums[:-count]) ** 2 / count
    similarity = correlate(expected, actual, mode="valid", method="fft") / np.sqrt(
        np.maximum(variance * power, 1e-20)
    )
    peak = int(np.argmax(similarity))
    score = float(similarity[peak])
    if score < 0.9 or peak in (0, len(similarity) - 1):
        return None
    competing = similarity.copy()
    competing[max(0, peak - 200) : peak + 201] = -1
    if score - float(np.max(competing)) < 0.05:
        return None
    return peak, score
