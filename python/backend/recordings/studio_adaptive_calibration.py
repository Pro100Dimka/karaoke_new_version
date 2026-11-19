"""Separate microphone calibration from bounded musical balance automation."""

from __future__ import annotations

from pathlib import Path
import threading

import numpy as np
import soundfile as sf
from scipy.signal import find_peaks

from backend.recordings.studio_audio import _check_cancel

_LOCAL_LIMIT_DB = 9.0
_TOTAL_LIMIT_DB = 36.0


def _periodicity(samples: np.ndarray, rate: int) -> float:
    if len(samples) < 64:
        return 0.0
    channel = int(np.argmax(np.sum(samples * samples, axis=0)))
    values = samples[:, channel] - np.mean(samples[:, channel])
    size = len(values)
    fft_size = 1 << (2 * size - 1).bit_length()
    spectrum = np.fft.rfft(values, fft_size)
    correlation = np.fft.irfft(spectrum * spectrum.conj(), fft_size)[:size]
    lags = np.arange(max(2, rate // 2000), min(size // 2, rate // 50) + 1)
    energy = np.r_[0, np.cumsum(values * values)]
    denominator = np.sqrt(energy[size - lags] * (energy[-1] - energy[lags]))
    normalized = correlation[lags] / np.maximum(denominator, 1e-20)
    peaks, _ = find_peaks(normalized)
    return float(np.clip(np.max(normalized[peaks], initial=0.0), 0, 1))


def _periodic_evidence(
    path: Path, active: np.ndarray, cancel: threading.Event
) -> tuple[float, float, int]:
    indices = np.flatnonzero(active)
    if not len(indices):
        return 0.0, 0.0, 0
    chosen = indices[np.unique(np.linspace(0, len(indices) - 1, min(24, len(indices))).astype(int))]
    scores = []
    with sf.SoundFile(path) as source:
        frame_size = max(1, round(source.samplerate * 0.1))
        for index in chosen:
            _check_cancel(cancel)
            source.seek(int(index * frame_size))
            samples = source.read(frame_size, always_2d=True, dtype="float64")
            scores.append(_periodicity(samples, source.samplerate))
    values = np.asarray(scores)
    return float(np.percentile(values, 75)), float(np.mean(values >= 0.8)), len(values)


def _noise_evidence(
    path: Path, levels: np.ndarray, matched: np.ndarray, cancel: threading.Event
) -> tuple[float | None, dict[str, object]]:
    level = float(np.median(levels[matched]))
    rests = levels[levels < level - 24]
    floor = float(np.percentile(rests, 90)) if len(rests) >= 3 else None
    periodicity, fraction, windows = _periodic_evidence(path, matched, cancel)
    method = "insufficient-noise-evidence"
    if floor is not None and fraction >= 0.25:
        method = "quiet-intervals-with-voiced-support"
    elif periodicity >= 0.995 and fraction >= 0.5:
        floor = level + 10 * np.log10(max(1e-8, 1 - periodicity))
        method = "high-periodicity-residual-bound"
    else:
        floor = None
    return floor, {
        "method": method,
        "estimatedNoiseFloorDbfs": floor,
        "quietIntervalSeconds": len(rests) * 0.1,
        "periodicity75": periodicity,
        "voicedWindowFraction": fraction,
        "windowsExamined": windows,
        "caveat": "signal-derived conservative evidence, not a microphone noise measurement",
    }


def _boost_limit(
    path: Path,
    levels: np.ndarray,
    requested: np.ndarray,
    matched: np.ndarray,
    cancel: threading.Event,
) -> tuple[float, dict[str, object]]:
    if not matched.any() or float(np.max(requested[matched])) <= _LOCAL_LIMIT_DB:
        return _LOCAL_LIMIT_DB, {"method": "large-positive-calibration-not-required"}
    floor, evidence = _noise_evidence(path, levels, matched, cancel)
    target = float(np.median((levels + requested)[matched]))
    ceiling = min(-45.0, target - 30.0)
    limit = (
        _LOCAL_LIMIT_DB if floor is None else float(np.clip(ceiling - floor, 0, _TOTAL_LIMIT_DB))
    )
    evidence.update(maximumDeliveredNoiseDbfs=ceiling, supportedBoostDb=limit)
    return limit, evidence


def calibrate_gains(
    path: Path,
    levels: np.ndarray,
    requested: np.ndarray,
    matched: np.ndarray,
    cancel: threading.Event,
) -> tuple[np.ndarray, dict[str, object]]:
    calibration = float(np.median(requested[matched])) if matched.any() else 0.0
    limit, evidence = _boost_limit(path, levels, requested, matched, cancel)
    applied = float(np.clip(calibration, -_TOTAL_LIMIT_DB, limit))
    local = np.clip(requested - calibration, -_LOCAL_LIMIT_DB, _LOCAL_LIMIT_DB)
    gains = np.clip(applied + local, -_TOTAL_LIMIT_DB, limit)
    return gains, {
        "inputCalibrationRequestedDb": calibration,
        "inputCalibrationDb": applied,
        "localAutomationLimitDb": _LOCAL_LIMIT_DB,
        "totalGainLimitDb": limit,
        "totalGainCutLimitDb": _TOTAL_LIMIT_DB,
        "maxBoostDb": limit,
        "maxCutDb": _TOTAL_LIMIT_DB,
        "calibrationEvidence": evidence,
    }
