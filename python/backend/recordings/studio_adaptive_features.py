"""Small, streaming measurements shared by adaptive vocal stages.

These measurements describe signal evidence; they do not identify a singer's
intent or claim that an isolated spectral peak is a room resonance.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import threading

import numpy as np
from numpy.typing import NDArray
from scipy.ndimage import maximum_filter1d
import soundfile as sf

from backend.domain_errors import DependencyError
from backend.recordings.studio_audio import _check_cancel

FloatArray = NDArray[np.float64]
BAND_EDGES = (
    (30, 120),
    (120, 300),
    (300, 800),
    (800, 1800),
    (1800, 4000),
    (4000, 5500),
    (5500, 9000),
    (10000, 18000),
)


@dataclass(frozen=True, slots=True)
class VoiceFeatures:
    rate: int
    frames: int
    channels: int
    step: float
    times: FloatArray
    rms_db: FloatArray
    peak_db: FloatArray
    bands_db: FloatArray
    active: NDArray[np.bool_]
    noise_floor_db: float
    noise_confident: bool
    frequencies: FloatArray
    spectrum_db: FloatArray
    spectral_frames: FloatArray
    low_edge_hz: float

    @property
    def active_seconds(self) -> float:
        return float(np.count_nonzero(self.active) * self.step)


def regions(mask: NDArray[np.bool_]) -> list[tuple[int, int]]:
    changes = np.diff(np.r_[False, mask, False].astype(np.int8))
    return [
        (int(a), int(b))
        for a, b in zip(np.flatnonzero(changes == 1), np.flatnonzero(changes == -1))
    ]


def active_mask(levels: FloatArray) -> tuple[NDArray[np.bool_], float, bool]:
    floor = float(np.percentile(levels, 10))
    high = max(
        float(np.percentile(levels, 90)),
        float(np.percentile(levels, 99)) - 6,
        float(np.max(levels)) - 12,
    )
    quiet = levels < floor + 1.8
    stationary = max((b - a for a, b in regions(quiet)), default=0) >= 18
    noise = bool(-108 < floor < -28 and high - floor >= 18 and stationary)
    threshold = max(-110, min(floor + 6 if noise else high - 40, high - 35))
    return levels > threshold, floor, noise


def _measure_blocks(
    path: Path, cancel: threading.Event
) -> tuple[FloatArray, FloatArray, FloatArray, NDArray[np.bool_], int, int, int]:
    rows: list[tuple[FloatArray, FloatArray, FloatArray, NDArray[np.bool_]]] = []
    with sf.SoundFile(path) as audio:
        if audio.frames == 0 or audio.samplerate < 1000:
            raise DependencyError("StudioMasterInvalidAudio", "Audio has no valid samples")
        frame_size = max(1, round(audio.samplerate * 0.02))
        frequency = np.fft.rfftfreq(frame_size, 1 / audio.samplerate)
        window = np.hanning(frame_size)
        masks = [
            (frequency >= lo) & (frequency < min(hi, audio.samplerate / 2)) for lo, hi in BAND_EDGES
        ]
        for block in audio.blocks(blocksize=frame_size * 128, dtype="float64", always_2d=True):
            _check_cancel(cancel)
            rows.append(_frame_statistics(block, frame_size, window, masks))
        return (
            np.concatenate([row[0] for row in rows]),
            np.concatenate([row[1] for row in rows]),
            np.concatenate([row[2] for row in rows]),
            np.concatenate([row[3] for row in rows]),
            audio.samplerate,
            audio.frames,
            audio.channels,
        )


def _frame_statistics(
    block: FloatArray,
    frame_size: int,
    window: FloatArray,
    masks: list[NDArray[np.bool_]],
) -> tuple[FloatArray, FloatArray, FloatArray, NDArray[np.bool_]]:
    if not np.isfinite(block).all():
        raise DependencyError("StudioMasterInvalidAudio", "Audio contains non-finite samples")
    padding = (-len(block)) % frame_size
    frames = np.pad(block, ((0, padding), (0, 0))).reshape(-1, frame_size, block.shape[1])
    energy = np.mean(frames**2, axis=1).max(axis=1)
    if padding:
        energy[-1] *= frame_size / (frame_size - padding)
    rms = 10 * np.log10(np.maximum(energy, 1e-12))
    peaks = 20 * np.log10(np.maximum(np.max(abs(frames), axis=(1, 2)), 1e-6))
    spectrum = abs(np.fft.rfft(frames * window[None, :, None], axis=1)) ** 2
    scale = max(1.0, frame_size * float(np.sum(window**2)))
    powers = np.stack(
        [2 * np.sum(spectrum[:, mask], axis=1).mean(axis=1) / scale for mask in masks], axis=1
    )
    linked = spectrum.sum(axis=2)
    tonal = linked.max(axis=1) > 0.2 * np.maximum(linked.sum(axis=1), 1e-12)
    return rms, peaks, 10 * np.log10(np.maximum(powers, 1e-12)), tonal


def _spectrum_indices(active: NDArray[np.bool_]) -> NDArray[np.int64]:
    indices = np.flatnonzero(active)
    if not indices.size:
        return np.asarray(indices, dtype=np.int64)
    selected = np.unique(np.linspace(0, len(indices) - 1, min(192, len(indices))).astype(int))
    return np.asarray(indices[selected], dtype=np.int64)


def _read_spectrum(
    audio: sf.SoundFile,
    index: int,
    step: float,
    window: FloatArray,
) -> FloatArray:
    count = len(window)
    start = round((index + 0.5) * step * audio.samplerate) - count // 2
    audio.seek(max(0, min(audio.frames - 1, start)))
    block = audio.read(count, dtype="float64", always_2d=True)
    if len(block) < count:
        block = np.pad(block, ((0, count - len(block)), (0, 0)))
    return np.asarray(
        np.mean(abs(np.fft.rfft(block * window[:, None], axis=0)) ** 2, axis=1), dtype=np.float64
    )


def _normalized_spectrum(
    spectrum: FloatArray,
    frequencies: FloatArray,
    centers: FloatArray,
    masks: list[NDArray[np.bool_]],
) -> FloatArray:
    values = np.asarray(
        [
            float(np.mean(spectrum[mask]))
            if mask.any()
            else float(np.interp(center, frequencies, spectrum))
            for center, mask in zip(centers, masks)
        ]
    )
    decibels = 10 * np.log10(np.maximum(values, 1e-14))
    anchor = float(np.percentile(decibels[(centers >= 200) & (centers <= 4000)], 75))
    # Sparse harmonics must be referenced to real energy, not numerical silence.
    anchor = max(anchor, float(np.max(decibels)) - 12)
    return np.asarray(decibels - anchor, dtype=np.float64)


def _low_edge(spectrum: FloatArray, frequencies: FloatArray) -> float | None:
    low_band = (frequencies >= 30) & (frequencies <= 450)
    low_power = spectrum[low_band]
    if low_power.sum() <= max(1e-16, spectrum.sum() * 0.015):
        return None
    position = min(
        len(low_power) - 1, int(np.searchsorted(np.cumsum(low_power), low_power.sum() * 0.08))
    )
    return float(frequencies[low_band][position])


def _spectral_summary(
    path: Path,
    active: NDArray[np.bool_],
    step: float,
    cancel: threading.Event,
) -> tuple[FloatArray, FloatArray, FloatArray, float]:
    indices = _spectrum_indices(active)
    with sf.SoundFile(path) as audio:
        centers = np.geomspace(45, min(18000, audio.samplerate * 0.46), 96)
        if not indices.size:
            return centers, np.zeros(96), np.empty((0, 96)), 55.0
        count = max(64, round(audio.samplerate * 0.12))
        frequency = np.fft.rfftfreq(count, 1 / audio.samplerate)
        window = np.hanning(count)
        summary: list[FloatArray] = []
        low_edges: list[float] = []
        masks = [
            (frequency >= center / 2 ** (1 / 12)) & (frequency <= center * 2 ** (1 / 12))
            for center in centers
        ]
        for index in indices:
            _check_cancel(cancel)
            spectrum = _read_spectrum(audio, int(index), step, window)
            summary.append(_normalized_spectrum(spectrum, frequency, centers, masks))
            edge = _low_edge(spectrum, frequency)
            if edge is not None:
                low_edges.append(edge)
        frames = np.asarray(summary, dtype=np.float64)
        return (
            centers,
            np.median(frames, axis=0),
            frames,
            float(np.percentile(low_edges, 10)) if low_edges else 120.0,
        )


def analyze_voice(path: Path, cancel: threading.Event) -> VoiceFeatures:
    _check_cancel(cancel)
    rms, peaks, bands, tonal, rate, frames, channels = _measure_blocks(path, cancel)
    step = max(1, round(rate * 0.02)) / rate
    active, floor, noise = active_mask(rms)
    # A low, steady vowel is not a stationary room-noise measurement. This veto
    # deliberately also preserves ambiguous tonal hum rather than erase singing.
    active |= tonal & (rms > -100)
    frequencies, spectrum, spectra, low = _spectral_summary(path, active, step, cancel)
    return VoiceFeatures(
        rate,
        frames,
        channels,
        step,
        np.asarray((np.arange(len(rms)) + 0.5) * step, dtype=np.float64),
        rms,
        peaks,
        bands,
        active,
        floor,
        noise,
        frequencies,
        spectrum,
        spectra,
        low,
    )


def protected_activity(features: VoiceFeatures, hold_seconds: float = 0.3) -> NDArray[np.bool_]:
    width = max(1, round(hold_seconds / features.step)) * 2 + 1
    return np.asarray(
        maximum_filter1d(features.active.astype(np.int8), size=width, mode="nearest") > 0
    )


def level_summary(features: VoiceFeatures) -> dict[str, float]:
    levels = features.rms_db[features.active]
    if not levels.size:
        levels = features.rms_db
    return {
        "activeSeconds": round(features.active_seconds, 4),
        "medianDbfs": float(np.median(levels)),
        "p10Dbfs": float(np.percentile(levels, 10)),
        "p90Dbfs": float(np.percentile(levels, 90)),
        "samplePeakDbfs": float(np.max(features.peak_db)),
    }
