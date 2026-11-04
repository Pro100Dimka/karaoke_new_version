from __future__ import annotations
from pathlib import Path
import math
import threading
import numpy as np
from numpy.typing import NDArray
from scipy.ndimage import median_filter, minimum_filter1d, uniform_filter1d
from scipy.signal import find_peaks
import soundfile as sf

from backend.recordings.studio_audio import _MAX_BOOST_DB, _PROFILE_SECONDS, _check_cancel


def _balance_curve(
    voice: NDArray[np.float64],
    backing: NDArray[np.float64],
    reference: NDArray[np.float64],
    original: NDArray[np.float64],
    *,
    phrase_smoothing: bool = False,
) -> tuple[NDArray[np.float64], NDArray[np.bool_]]:
    # Require both singers and both accompaniments. Do not normalize rests or a noise floor
    # to a professional singer. This is an energy guard, not a claim of speech recognition.
    floor = max(-55.0, float(np.percentile(voice, 20)) + 10.0)
    upper = float(np.percentile(voice, 80))
    if floor >= upper:
        floor = max(-55.0, upper - 10.0)
    reliable = (
        (voice > floor)
        & (reference > max(-55.0, float(np.max(reference)) - 30))
        & (backing > -60)
        & (original > -60)
    )
    desired = np.minimum((reference - original) - (voice - backing), _MAX_BOOST_DB)
    if not reliable.any():
        return np.zeros_like(voice), reliable
    # Bound boosts, not attenuation: a loud singer may need more than 9 dB of reduction.
    # Carry the measured balance through gaps instead of restoring full vocal gain there.
    positions = np.arange(len(voice))
    gains = np.interp(positions, positions[reliable], desired[reliable])
    # A two-second median rejects syllable transients; a one-second ramp avoids gain steps.
    gains = uniform_filter1d(median_filter(gains, size=21, mode="nearest"), size=11, mode="nearest")
    # Never boost a pause just because adjacent words were quiet. Attenuation may persist.
    if phrase_smoothing:
        gains = _smooth_boosts(gains, reliable)
    else:
        gains = np.minimum(gains, np.where(reliable, _MAX_BOOST_DB, 0.0))
    return gains, reliable


def _voice_filters(
    path: Path,
    levels: NDArray[np.float64],
    cancel: threading.Event,
) -> tuple[list[str], dict[str, object]]:
    filters = ["highpass=f=60"]
    noise_floor = float(np.percentile(levels, 10))
    quiet_seconds = float(np.count_nonzero(levels <= noise_floor + 3) * _PROFILE_SECONDS)
    contrast = float(np.percentile(levels, 80)) - noise_floor
    noise_detected = -75 < noise_floor < -35 and contrast >= 18 and quiet_seconds >= 1
    if noise_detected:
        # A soft expander, never a hard mute: keep breaths and word tails recoverable.
        threshold = 10 ** ((noise_floor + 6) / 20)
        filters.append(
            f"agate=threshold={threshold:.9f}:range=0.5:ratio=1.5:"
            "attack=5:release=250:makeup=1:link=maximum:detection=rms"
        )
    centers, spectral_frames, ratios = _spectral_evidence(path, levels, noise_floor, cancel)
    resonances, intensity = _resonance_filters(centers, spectral_frames, ratios, filters)
    if intensity > 0:
        filters.append(f"deesser=i={intensity:.6f}:m=0.25:f=0.5")
    tails = _voice_tails(levels)
    space_eligible = len(tails) >= 3 and float(np.median(tails)) < -18
    return filters, {
        "spaceEligible": space_eligible,
        "spaceGapCount": len(tails),
        "spaceTailRelativeDb": float(np.median(tails)) if tails else None,
        "noiseFloorDbfs": noise_floor,
        "pauseExpansionApplied": noise_detected,
        "pauseExpansionLimitDb": 6.0206 if noise_detected else 0,
        "activeAnalysisSeconds": len(spectral_frames) * _PROFILE_SECONDS,
        "resonanceFrequenciesHz": resonances,
        "deesserIntensity": intensity,
        "method": "conservative-signal-dependent",
    }


def apply_phrase_detail(
    voice_db: np.ndarray,
    reference_db: np.ndarray,
    original_db: np.ndarray,
    backing_db: np.ndarray,
    gains: np.ndarray,
    reliable: np.ndarray,
) -> dict[str, object]:
    # Support sustained dips within a phrase, not pauses, consonant attacks or
    # intentional softness also present in the reference. Preserve the broad curve.
    floor = max(-50.0, float(np.percentile(voice_db, 10)) + 15)
    supported = reliable & (voice_db > floor)
    supported = minimum_filter1d(supported.astype(float), size=5, mode="constant")
    local_level = median_filter(voice_db, size=5, mode="nearest")
    phrase_level = median_filter(voice_db, size=31, mode="nearest")
    deficit = (reference_db - original_db) - (voice_db + gains - backing_db)
    detail = (
        np.minimum(
            np.clip((phrase_level - local_level - 6) * 0.25, 0, 1.5),
            np.clip((deficit - 3) * 0.25, 0, 1.5),
        )
        * supported
    )
    if np.count_nonzero(supported) < 30:
        detail.fill(0)
    detail = uniform_filter1d(detail, size=5, mode="constant") * supported
    detail = np.minimum(detail, np.maximum(0, _MAX_BOOST_DB - gains))
    gains += detail
    return {
        "maxBoostDb": float(np.max(detail)),
        "limitDb": 1.5,
        "affectedSeconds": float(np.count_nonzero(detail > 0.1) * _PROFILE_SECONDS),
        "method": "supported-intraphrase-dips",
    }


def _smooth_boosts(gains: np.ndarray, reliable: np.ndarray) -> np.ndarray:
    # Ramp boosts down before rests. Bound gain velocity to 3 dB/s in both directions.
    ceiling = uniform_filter1d(minimum_filter1d(reliable.astype(float), size=11), size=9)
    gains = np.minimum(gains, ceiling * _MAX_BOOST_DB)
    for indices in (range(1, len(gains)), range(len(gains) - 2, -1, -1)):
        step = indices.step
        for index in indices:
            gains[index] = min(gains[index], gains[index - step] + 0.3)
    return gains


def _spectral_evidence(
    path: Path,
    levels: np.ndarray,
    noise_floor: float,
    cancel: threading.Event,
) -> tuple[np.ndarray, list[np.ndarray], list[float]]:
    spectral_frames, ratios = [], []
    floor = max(-55.0, float(np.max(levels)) - 30, noise_floor + 10)
    with sf.SoundFile(path) as source:
        centers = np.geomspace(150, min(10000, source.samplerate * 0.45), 96)
        size = round(source.samplerate * _PROFILE_SECONDS)
        window = np.hanning(size)[:, None]
        frequencies = np.fft.rfftfreq(size, 1 / source.samplerate)
        band_bins = [
            slice(
                int(np.searchsorted(frequencies, center / 1.04)),
                int(np.searchsorted(frequencies, center * 1.04, side="right")),
            )
            for center in centers
        ]
        presence_bins = (frequencies >= 500) & (frequencies < 4000)
        treble_bins = (frequencies >= 4000) & (frequencies < 10000)
        for index, samples in enumerate(source.blocks(blocksize=size, always_2d=True)):
            _check_cancel(cancel)
            if levels[index] <= floor or len(samples) < size:
                continue
            spectrum = np.mean(abs(np.fft.rfft(samples * window, axis=0)) ** 2, axis=1)
            # Band averages suppress isolated FFT-bin/harmonic peaks before resonance selection.
            envelope = np.asarray([float(np.mean(spectrum[selected])) for selected in band_bins])
            spectral_frames.append(10 * np.log10(np.maximum(envelope, 1e-20)))
            presence = float(np.sum(spectrum[presence_bins]))
            treble = float(np.sum(spectrum[treble_bins]))
            ratios.append(10 * math.log10(max(treble, 1e-20) / max(presence, 1e-20)))
    return centers, spectral_frames, ratios


def _resonance_filters(
    centers: np.ndarray,
    spectral_frames: list[np.ndarray],
    ratios: list[float],
    filters: list[str],
) -> tuple[list[float], float]:
    resonances: list[float] = []
    intensity = 0.0
    # Sparse/uncertain evidence must not turn into a blanket EQ or de-esser preset.
    if len(spectral_frames) >= 20:
        spectra = np.asarray(spectral_frames)
        prominence = spectra - median_filter(spectra, size=(1, 9), mode="nearest")
        median_prominence = np.median(prominence, axis=0)
        peaks, _ = find_peaks(median_prominence, height=6, distance=6)
        candidates = [
            int(i)
            for i in peaks
            if 900 <= centers[i] <= 6500 and float(np.mean(prominence[:, i] > 6)) >= 0.35
        ]
        candidates.sort(key=lambda i: float(median_prominence[i]), reverse=True)
        resonances = [float(centers[i]) for i in candidates[:2]]
        for frequency in resonances:
            # Small dynamic cuts protect natural vowel/formant differences between singers.
            filters.append(
                f"adynamicequalizer=dfrequency={frequency:.3f}:dqfactor=6:"
                f"tfrequency={frequency:.3f}:tqfactor=6:mode=cutabove:"
                "auto=adaptive:threshold=0.01:range=1:ratio=0.5:attack=20:release=180"
            )
        median_ratio, high_ratio = np.percentile(ratios, [50, 95])
        if high_ratio > -10:
            intensity = float(np.clip((high_ratio - median_ratio - 6) / 36, 0, 0.2))
    return resonances, intensity


def _voice_tails(levels: NDArray[np.float64]) -> list[float]:
    # Quiet gaps can reveal lingering room energy, but do not identify its cause.
    # With too few gaps, avoid adding an unverified reflection bed.
    upper = float(np.percentile(levels, 80))
    ends = np.flatnonzero((levels[:-1] > upper - 15) & (levels[1:] <= upper - 15)) + 1
    tails = [
        float(np.max(levels[i + 2 : i + 5]) - np.median(levels[i - 5 : i]))
        for i in ends
        if i >= 5 and i + 5 < len(levels) and float(np.max(levels[i : i + 5])) < upper - 15
    ]
    return tails
