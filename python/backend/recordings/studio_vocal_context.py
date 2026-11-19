"""Shared measured level and voicing evidence for a take and its reference."""

from dataclasses import dataclass
from pathlib import Path
import threading

import numpy as np
from numpy.typing import NDArray
from scipy.ndimage import gaussian_filter1d, uniform_filter1d
import soundfile as sf

from backend.recordings.studio_audio import _check_cancel, _profile


@dataclass(frozen=True, slots=True)
class ReferenceBody:
    times: np.ndarray
    levels: np.ndarray
    supported: np.ndarray

    def mapped(self, times: np.ndarray, source_times: np.ndarray) -> "ReferenceBody":
        levels = np.interp(source_times, self.times, self.levels, left=-120, right=-120)
        support = np.interp(source_times, self.times, self.supported.astype(float), left=0, right=0)
        return ReferenceBody(times, levels, support > 0.5)

    def on_grid(self, times: np.ndarray) -> "ReferenceBody":
        levels = np.interp(times, self.times, self.levels, left=-120, right=-120)
        step = float(np.median(np.diff(times))) if len(times) > 1 else 0.1
        left = np.searchsorted(self.times, times - step / 2)
        right = np.searchsorted(self.times, times + step / 2)
        count = np.r_[0, np.cumsum(self.supported)]
        # A word between two 100 ms centers is still measured support in its
        # control interval. Pool actual 20 ms evidence, never a held level curve.
        return ReferenceBody(times, levels, count[right] > count[left])


@dataclass(frozen=True, slots=True)
class ReferenceLevels:
    balance: tuple[np.ndarray, np.ndarray, np.ndarray] | None
    correction_db: float | None
    body: ReferenceBody | None


def vocal_activity(levels: NDArray[np.float64]) -> NDArray[np.bool_]:
    floor = max(
        -80.0, min(float(np.percentile(levels, 80)) - 24, float(np.percentile(levels, 10)) + 10)
    )
    return levels > floor


def measured_levels(
    voice: Path, meter_times: np.ndarray, momentary: np.ndarray, cancel: threading.Event
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    rms = _profile(voice, cancel, frame_seconds=0.02)
    band = _profile(voice, cancel, voice_band=True)
    times = (np.arange(len(rms)) + 0.5) * 0.02
    active = (
        np.interp(times, (np.arange(len(band)) + 0.5) * 0.1, vocal_activity(band).astype(float))
        > 0.5
    )
    if not active.any() and np.max(rms) > -80:
        active = vocal_activity(rms)
    broad = 10 * np.log10(
        np.maximum(uniform_filter1d(10 ** (rms / 10), size=20, mode="nearest"), 1e-12)
    )
    valid = (momentary > -70) & (meter_times >= 0)
    if not valid.any():
        return times, rms, active & False, np.zeros_like(rms)
    offsets = momentary[valid] - np.interp(meter_times[valid], times, broad)
    offset = np.interp(
        times, meter_times[valid], gaussian_filter1d(offsets, sigma=2, mode="nearest")
    )
    return times, rms + offset, active, offset


def _frame_voicing(frames: np.ndarray, rate: int, transform: int, hz: np.ndarray) -> np.ndarray:
    frames = frames - np.mean(frames, axis=1, keepdims=True)
    power = np.sum(abs(np.fft.rfft(frames, n=transform, axis=1)) ** 2, axis=2)
    # Preserve low fundamentals; rejecting hum belongs to the lag search below.
    power[:, hz > 3500] = 0
    correlation = np.fft.irfft(power, n=transform, axis=1)
    low = max(1, round(rate / 500))
    high = int(np.ceil(rate / 70 * 1.01))
    lags = np.arange(low - 1, high + 2)
    overlap = np.maximum(1 - lags / frames.shape[1], 1e-9)
    scores = correlation[:, lags] / np.maximum(correlation[:, [0]], 1e-20) / overlap
    peaks = (scores[:, 1:-1] > scores[:, :-2]) & (scores[:, 1:-1] >= scores[:, 2:])
    peaks &= lags[1:-1] <= frames.shape[1] / 2
    confidence = np.max(np.where(peaks, scores[:, 1:-1], 0), axis=1)
    return np.asarray(np.clip(confidence, 0, 1), dtype=float)


def voicing_profile(voice: Path, cancel: threading.Event) -> np.ndarray:
    confidence = []
    with sf.SoundFile(voice) as source:
        size = max(1, round(source.samplerate * 0.04))
        transform = 2 ** int(np.ceil(np.log2(2 * size)))
        hz = np.fft.rfftfreq(transform, 1 / source.samplerate)
        for block in source.blocks(blocksize=size * 32, always_2d=True):
            _check_cancel(cancel)
            complete = len(block) // size * size
            for frames in (
                block[:complete].reshape(-1, size, source.channels),
                block[complete:][None, :, :],
            ):
                if not frames.size:
                    continue
                profile = _frame_voicing(frames, source.samplerate, transform, hz)
                confidence.extend(profile.tolist())
    _check_cancel(cancel)
    return np.asarray(confidence)


def voiced_activity(
    voice: Path, times: np.ndarray, active: np.ndarray, cancel: threading.Event
) -> np.ndarray:
    profile = voicing_profile(voice, cancel)
    confidence = np.interp(times, (np.arange(len(profile)) + 0.5) * 0.04, profile)
    return np.asarray(active & (confidence >= 0.65), dtype=bool)
