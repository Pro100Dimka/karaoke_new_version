from __future__ import annotations
from pathlib import Path
import math
import threading
import numpy as np
from numpy.typing import NDArray
from scipy.ndimage import (
    gaussian_filter1d,
    median_filter,
    minimum_filter1d,
    uniform_filter1d,
)
from scipy.signal import find_peaks
import soundfile as sf

from backend.recordings.studio_audio import _MAX_BOOST_DB, _PROFILE_SECONDS, _check_cancel, _profile

from backend.recordings.studio_compression import (
    _reference_compression as _reference_compression,
    _reference_compressor_timing as _reference_compressor_timing,
)


def _slow_gain_envelope(
    values: NDArray[np.float64], *, seconds: float = 3.0
) -> NDArray[np.float64]:
    """Smooth phrase-level gain without following syllables or drum transients.

    Reflect edges instead of padding with silence. This is an offline renderer:
    looking ahead is safe and avoids the audible lag of causal gain riding.
    """
    values = np.asarray(values, dtype=np.float64)
    if values.size < 2:
        return values.copy()
    frames = max(1, round(seconds / _PROFILE_SECONDS))
    # Bound the entire Gaussian window to seconds, not six times that duration.
    # Distant future phrases must not attenuate the current sustained phrase.
    median_size = min(
        values.size if values.size % 2 else values.size - 1, max(3, frames // 2 * 2 + 1)
    )
    cleaned = median_filter(values, size=median_size, mode="nearest")
    return np.asarray(
        gaussian_filter1d(cleaned, sigma=max(1.0, frames / 6.0), truncate=3.0, mode="nearest"),
        dtype=np.float64,
    )


def _balance_curve(
    voice: NDArray[np.float64],
    backing: NDArray[np.float64],
    reference: NDArray[np.float64],
    original: NDArray[np.float64],
    *,
    phrase_smoothing: bool = False,
) -> tuple[NDArray[np.float64], NDArray[np.bool_]]:
    # Compare only voiced frames; never amplify silence to reference level.
    upper = float(np.percentile(voice, 80))
    floor = max(-80.0, min(float(np.percentile(voice, 20)) + 10.0, upper - 10.0))
    reliable = (voice > floor) & (reference > max(-55.0, float(np.max(reference)) - 30))
    if not phrase_smoothing:
        reliable &= (backing > -60) & (original > -60)
    if not reliable.any():
        return np.zeros_like(voice), reliable
    target = backing + reference - original
    desired = np.minimum(target - voice, _MAX_BOOST_DB)
    positions = np.arange(len(voice))
    # Interpolate *only* between reliable vocal frames; then use one slow
    # phrase-level envelope rather than applying a second syllable tracker.
    raw = np.interp(positions, positions[reliable], desired[reliable])
    gains = _slow_gain_envelope(raw)
    if phrase_smoothing:
        # The global offset is held through rests; local boosts are faded using
        # a slow activity envelope, never reset at individual syllable gaps.
        baseline = float(np.median(gains[reliable]))
        activity = _slow_gain_envelope(reliable.astype(np.float64), seconds=2.0)
        gains = baseline + (gains - baseline) * np.clip(activity, 0.0, 1.0)
    noise = voice <= max(-70.0, upper - 45.0)
    gains[noise] = np.minimum(gains[noise], 0.0)
    return np.clip(gains, -18.0, _MAX_BOOST_DB), reliable


def _protect_vocal_presence(
    gains: NDArray[np.float64],
    voice: NDArray[np.float64],
    backing: NDArray[np.float64],
) -> tuple[NDArray[np.float64], dict[str, float]]:
    """Prevent reference matching from burying vocals during loud passages.

    Track slow accompaniment changes, not individual drum hits. The adjustment
    never boosts pauses and is capped to avoid excessive noise or pumping.
    """
    if not len(gains) or len(gains) != len(voice) or len(voice) != len(backing):
        return gains, {"presenceBoostMaxDb": 0.0}
    active_floor = min(
        float(np.percentile(voice, 80)) - 6.0,
        max(-48.0, float(np.percentile(voice, 20)) + 9.0),
    )
    active = voice > active_floor
    if np.count_nonzero(active) < 10:
        return gains, {"presenceBoostMaxDb": 0.0}
    # A quiet intro should not establish the target level for the climax.
    local_backing = median_filter(backing, size=31, mode="nearest")
    reference_backing = float(np.percentile(local_backing[active], 35))
    rise = np.clip(local_backing - reference_backing, 0.0, 8.0)
    # Preserve at least half of the musical rise in vocal prominence, while
    # leaving the original reference matching intact on quieter passages.
    minimum_gain = np.minimum(5.0, 0.55 * rise)
    corrected = np.maximum(gains, minimum_gain)
    # Limit any *additional* gain to +5 dB and avoid sudden envelope changes.
    extra = np.clip(corrected - gains, 0.0, 5.0)
    extra = _slow_gain_envelope(extra)
    extra *= np.clip(_slow_gain_envelope(active.astype(float), seconds=2.0), 0.0, 1.0)
    result = np.minimum(np.clip(gains + extra, -18.0, _MAX_BOOST_DB), gains + 5.0)
    return result, {
        "presenceBoostMaxDb": float(np.max(extra)),
        "presenceBoostMeanDb": float(np.mean(extra[active])),
        "backingReferenceDbfs": reference_backing,
    }


def _voice_filters(
    path: Path,
    levels: NDArray[np.float64],
    cancel: threading.Event,
    reference: Path | None = None,
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
    tone = _tone_filters(reference, centers, spectral_frames, ratios, filters, cancel)
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
        **tone,
        "method": "conservative-signal-dependent",
    }


def _tone_filters(
    reference: Path | None,
    centers: np.ndarray,
    spectral_frames: list[np.ndarray],
    ratios: list[float],
    filters: list[str],
    cancel: threading.Event,
) -> dict[str, object]:
    reference_tone = _reference_tone(reference, cancel) if reference else None
    reference_ratio = reference_tone[0] if reference_tone else None
    cuts = (
        _reference_cuts(centers, spectral_frames, reference_tone, filters)
        if reference_tone and len(spectral_frames) >= 30
        else {}
    )
    clarity = (
        _clarity_filters(
            ratios, filters, reference_ratio, 0 if reference_tone is not None else None
        )
        if centers[-1] >= 8000
        else 0.0
    )
    return {
        "clarityAmount": clarity,
        "referenceTrebleRatioDb": reference_ratio,
        **cuts,
    }


def _backing_curve(
    backing: NDArray[np.float64], original: NDArray[np.float64]
) -> NDArray[np.float64]:
    reliable = (backing > -60) & (original > -60)
    if not reliable.any():
        return np.zeros_like(backing)
    offset = float(np.median((backing - original)[reliable]))
    desired = np.minimum(original + offset - backing, _MAX_BOOST_DB)
    positions = np.arange(len(backing))
    gains = np.interp(positions, positions[reliable], desired[reliable])
    gains = uniform_filter1d(median_filter(gains, size=21, mode="nearest"), size=11, mode="nearest")
    return _smooth_boosts(gains, reliable)


def _tone_envelope(centers: np.ndarray, frames: list[np.ndarray]) -> np.ndarray:
    spectrum = np.asarray(frames)
    middle = np.median(spectrum[:, (centers >= 800) & (centers < 1600)], axis=1)
    return np.asarray(
        median_filter(np.median(spectrum - middle[:, None], axis=0), size=11, mode="nearest")
    )


def _smooth_tone_excess(
    excess: np.ndarray, log_frequency: np.ndarray, usable: np.ndarray
) -> np.ndarray:
    smooth = np.empty_like(excess)
    for index, frequency in enumerate(log_frequency):
        neighbors = usable & (np.abs(log_frequency - frequency) <= 1 / 3)
        smooth[index] = float(np.median(excess[neighbors])) if np.any(neighbors) else 0.0
    return smooth


def _tone_candidates(
    usable: np.ndarray, smooth: np.ndarray, log_frequency: np.ndarray
) -> list[int]:
    candidates = np.flatnonzero(usable & (smooth > 2.5))
    selected: list[int] = []
    for candidate in sorted(candidates, key=lambda i: smooth[i], reverse=True):
        index = int(candidate)
        if all(abs(log_frequency[index] - log_frequency[other]) >= 0.8 for other in selected):
            selected.append(int(index))
        if len(selected) == 3:
            break
    return selected


def _reference_cuts(
    centers: np.ndarray,
    frames: list[np.ndarray],
    reference: tuple[float, np.ndarray, np.ndarray],
    filters: list[str],
) -> dict[str, object]:
    """Match broad tonal *excesses* to the measured reference, not preset EQ bands.

    Restrict corrective EQ to statistically supported broad peaks. Never boost
    unknown frequency regions or chase a singer's individual harmonics.
    """
    usable = (centers >= 180) & (centers <= min(6500, centers[-1]))
    if not np.any(usable) or not np.any((centers >= 800) & (centers < 1600)):
        return {"referenceEqBands": [], "referenceEqStatus": "insufficient-spectrum"}
    measured = _tone_envelope(centers, frames)
    expected = np.interp(centers, reference[1], reference[2])
    excess = measured - expected
    # The median removes arbitrary broadband gain differences between files.
    excess -= float(np.median(excess[usable]))
    # Analyze broad bands rather than individual spectral bins / harmonics.
    log_frequency = np.log2(np.maximum(centers, 1))
    smooth = _smooth_tone_excess(excess, log_frequency, usable)
    selected = _tone_candidates(usable, smooth, log_frequency)
    report: list[dict[str, float]] = []
    for index in sorted(selected):
        # Safety cap only; both the frequency and requested attenuation are
        # inferred from this song's reference spectrum.
        reduction = float(np.clip(smooth[index] * 0.5, 0, 3.0))
        frequency = float(centers[index])
        filters.append(f"equalizer=f={frequency:.3f}:t=q:w=0.7:g={-reduction:.6f}")
        report.append(
            {
                "frequencyHz": frequency,
                "reductionDb": reduction,
                "measuredExcessDb": float(smooth[index]),
            }
        )
    return {"referenceEqBands": report, "referenceEqStatus": "measured"}


def _reference_tone(
    path: Path, cancel: threading.Event
) -> tuple[float, np.ndarray, np.ndarray] | None:
    levels = _profile(path, cancel)
    centers, frames, ratios = _spectral_evidence(
        path, levels, float(np.percentile(levels, 10)), cancel
    )
    if len(ratios) < 30 or centers[-1] < 8000:
        return None
    return float(np.median(ratios)), centers, _tone_envelope(centers, frames)


def _clarity_filters(
    ratios: list[float],
    filters: list[str],
    reference_ratio: float | None = None,
    body_cut: float | None = None,
) -> float:
    # Require sustained vocal evidence; do not brighten silence or an already bright take.
    median = float(np.median(ratios)) if len(ratios) >= 30 else 0.0
    target, scale, limit = (-14, 5, 1) if reference_ratio is None else (reference_ratio, 2, 1.5)
    amount = float(np.clip((target - median) / scale, 0, limit)) if -40 < median < 0 else 0.0
    reduction = min(amount, 1) * 1.5 if body_cut is None else body_cut
    if reduction:
        frequency = 350 if body_cut is None else 260
        filters.append(f"equalizer=f={frequency}:t=q:w=0.7:g={-reduction:.6f}")
    if amount:
        filters.append(f"treble=f=5500:t=q:w=0.7:g={2 * amount:.6f}")
    return amount


def _smooth_boosts(gains: np.ndarray, reliable: np.ndarray, *, causal: bool = False) -> np.ndarray:
    # Keep noise protection separate from the direction of vocal level tracking.
    ceiling = uniform_filter1d(minimum_filter1d(reliable.astype(float), size=11), size=9)
    gains = np.minimum(gains, ceiling * _MAX_BOOST_DB)
    if causal:
        # Never let a later quiet syllable attenuate earlier words. Reacquire after rests.
        for index in range(1, len(gains)):
            if reliable[index] and reliable[index - 1]:
                gains[index] = np.clip(gains[index], gains[index - 1] - 1.2, gains[index - 1] + 1.2)
        return gains
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
