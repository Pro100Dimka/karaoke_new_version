"""Reject ambiguous source recurrence before creating reference echo effects."""

from pathlib import Path
import math
import threading

import numpy as np
import soundfile as sf
from scipy.fft import irfft, next_fast_len, rfft
from scipy.signal import find_peaks, resample_poly

from backend.recordings.studio_audio import _check_cancel


def independent_echo_taps(
    path: Path,
    cepstra: np.ndarray,
    positions: np.ndarray,
    taps: tuple[tuple[float, float], ...],
    cancel: threading.Event,
) -> tuple[tuple[tuple[float, float], ...], np.ndarray]:
    """Near-perfect source recurrence cannot establish a separate quiet echo.

    Pitch harmonics and periodic vibrato also create long-quefrency peaks.
    Abstain on ambiguous windows without declaring that a real echo is absent.
    Validate only selected candidates, so rejected peaks cannot promote weaker
    source-periodicity peaks into replacement effects.
    """
    if not taps:
        return taps, cepstra
    indices = [round(delay * 8000) for delay, _ in taps]
    noise = float(np.median(np.abs(np.percentile(cepstra, 75, axis=0)[320:4800])))
    threshold = max(0.01, noise * 6)
    evidence = _independent_evidence(path, cepstra, positions, taps, threshold, cancel)
    verified = []
    for (delay, _), index in zip(taps, indices):
        agreeing = evidence[:, index] > threshold
        if np.count_nonzero(agreeing) >= max(3, len(evidence) * 0.25):
            gain = float(np.clip(2 * np.percentile(evidence[agreeing, index], 75), 0, 0.35))
            verified.append((delay, gain))
    return tuple(verified), evidence


def _independent_evidence(
    path: Path,
    cepstra: np.ndarray,
    positions: np.ndarray,
    taps: tuple[tuple[float, float], ...],
    threshold: float,
    cancel: threading.Event,
) -> np.ndarray:
    evidence = cepstra.copy()
    indices = [round(delay * 8000) for delay, _ in taps]
    # Region detection must use the same accepted evidence as support and gain.
    evidence[:, indices] = np.where(evidence[:, indices] > threshold, evidence[:, indices], 0)
    with sf.SoundFile(path) as source:
        divisor = math.gcd(source.samplerate, 8000)
        for row, position in enumerate(positions):
            _check_cancel(cancel)
            supported = [index for index in indices if evidence[row, index] > threshold]
            if not supported:
                continue
            source.seek(round(position * source.samplerate))
            samples = source.read(source.samplerate * 2, always_2d=True)[:, :2]
            samples = resample_poly(samples, 8000 // divisor, source.samplerate // divisor, axis=0)
            for index in _source_recurrences(samples, supported):
                evidence[row, index] = 0
    return evidence


def _source_recurrences(samples: np.ndarray, indices: list[int]) -> set[int]:
    # A two-second window can contain different notes and hide their strong
    # local periodicity. A half-second section can explain a candidate peak
    # without implying that the whole phrase repeats at that lag.
    windows = [samples, *(samples[start : start + 4000] for start in range(0, len(samples), 4000))]
    ambiguous: set[int] = set()
    for window in windows:
        correlation, peaks, period = _recurrence_evidence(window)
        for index in indices:
            if index not in ambiguous and _is_source_recurrence(correlation, peaks, period, index):
                ambiguous.add(index)
        if len(ambiguous) == len(indices):
            break
    return ambiguous


def _recurrence_evidence(samples: np.ndarray) -> tuple[np.ndarray, np.ndarray, int]:
    samples = samples - samples.mean(axis=0, keepdims=True)
    length = len(samples)
    size = next_fast_len(2 * length - 1)
    spectrum = rfft(samples, n=size, axis=0)
    raw = irfft(np.sum(np.abs(spectrum) ** 2, axis=1), n=size)[: length // 2 + 1]
    energy = np.r_[0.0, np.cumsum(np.sum(samples**2, axis=1))]
    shifts = np.arange(len(raw))
    normalization = np.sqrt(np.maximum(energy[length - shifts] * (energy[-1] - energy[shifts]), 0))
    correlation = raw / np.maximum(normalization, 1e-20)
    peaks, _ = find_peaks(correlation)
    peaks = peaks[correlation[peaks] > 0]
    # Strong recurrence at 50–1000 Hz establishes a voiced pitch period.
    short = peaks[(peaks >= 8) & (peaks <= 160) & (correlation[peaks] >= 0.9)]
    return correlation, peaks, int(short[0]) if len(short) else 0


def _is_source_recurrence(
    correlation: np.ndarray, peaks: np.ndarray, period: int, shift: int
) -> bool:
    if not 0 < shift < len(correlation):
        return False
    if abs(correlation[shift]) >= 0.9:
        return True
    # Vibrato can weaken a distant repeat while keeping it at the same pitch
    # phase. Within a tenth of a measured cycle, the echo evidence is ambiguous.
    return bool(period and np.any(np.abs(peaks - shift) <= period * 0.1))
