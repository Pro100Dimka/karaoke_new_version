from __future__ import annotations
from pathlib import Path
import math
import threading
import numpy as np
from numpy.typing import NDArray
from scipy.ndimage import median_filter, minimum_filter1d, uniform_filter1d
from scipy.signal import find_peaks
import soundfile as sf

from backend.recordings.studio_audio import _MAX_BOOST_DB, _PROFILE_SECONDS, _check_cancel, _profile


def _balance_curve(
    voice: NDArray[np.float64],
    backing: NDArray[np.float64],
    reference: NDArray[np.float64],
    original: NDArray[np.float64],
    *,
    phrase_smoothing: bool = False,
) -> tuple[NDArray[np.float64], NDArray[np.bool_]]:
    # Do not normalize rests or a noise floor to a professional singer.
    floor = max(-55.0, float(np.percentile(voice, 20)) + 10.0)
    upper = float(np.percentile(voice, 80))
    if floor >= upper:
        floor = max(-55.0, upper - 10.0)
    reliable = (voice > floor) & (reference > max(-55.0, float(np.max(reference)) - 30))
    if phrase_smoothing:
        # Match the original singer directly, without scaling to the accompaniment.
        target = reference
    else:
        reliable &= (backing > -60) & (original > -60)
        target = backing
    desired = np.minimum(target - voice, _MAX_BOOST_DB)
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
        gains = _smooth_boosts(gains, reliable, causal=True)
    else:
        gains = np.minimum(gains, np.where(reliable, _MAX_BOOST_DB, 0.0))
    return gains, reliable


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
    corrected = np.maximum(gains, minimum_gain - 4.0)
    # Limit any *additional* gain to +5 dB and avoid sudden envelope changes.
    extra = np.clip(corrected - gains, 0.0, 5.0)
    extra = uniform_filter1d(extra, size=21, mode="nearest")
    extra[~(uniform_filter1d(active.astype(float), size=11) > 0.25)] = 0.0
    result = np.clip(gains + extra, -18.0, _MAX_BOOST_DB)
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
        _clarity_filters(ratios, filters, reference_ratio, 0 if reference_tone is not None else None)
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
    smooth = np.empty_like(excess)
    for index, frequency in enumerate(log_frequency):
        neighbors = usable & (np.abs(log_frequency - frequency) <= 1 / 3)
        smooth[index] = float(np.median(excess[neighbors])) if np.any(neighbors) else 0.0
    candidates = np.flatnonzero(usable & (smooth > 2.5))
    selected: list[int] = []
    for index in sorted(candidates, key=lambda i: smooth[i], reverse=True):
        if all(abs(log_frequency[index] - log_frequency[other]) >= 0.8 for other in selected):
            selected.append(int(index))
        if len(selected) == 3:
            break
    report: list[dict[str, float]] = []
    for index in sorted(selected):
        # Safety cap only; both the frequency and requested attenuation are
        # inferred from this song's reference spectrum.
        reduction = float(np.clip(smooth[index] * 0.5, 0, 3.0))
        frequency = float(centers[index])
        filters.append(f"equalizer=f={frequency:.3f}:t=q:w=0.7:g={-reduction:.6f}")
        report.append({"frequencyHz": frequency, "reductionDb": reduction,
                       "measuredExcessDb": float(smooth[index])})
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


def _reference_presence(
    gains: NDArray[np.float64],
    voice: NDArray[np.float64],
    backing: NDArray[np.float64],
    reference: NDArray[np.float64],
    original_backing: NDArray[np.float64],
) -> tuple[NDArray[np.float64], dict[str, float | str]]:
    """Match reference vocal prominence without pulling the voice down in quiet music.

    Compare reference and performance at similar accompaniment *percentiles*,
    rather than assuming a quiet accompaniment means a quiet singer. The
    global level is corrected separately from slow, zero-median phrase riding.
    """
    if len(gains) != len(voice) or len(voice) != len(backing) or not len(reference) or not len(original_backing):
        return gains, {"method": "unavailable-reference"}
    n = min(len(reference), len(original_backing))
    ref, orig = reference[:n], original_backing[:n]
    valid_ref = np.isfinite(ref) & np.isfinite(orig)
    valid = np.isfinite(voice) & np.isfinite(backing) & np.isfinite(gains)
    if np.count_nonzero(valid_ref) < 8 or np.count_nonzero(valid) < 8:
        return gains, {"method": "insufficient-valid-frames"}
    ref_floor, voice_floor = np.percentile(ref[valid_ref], 20), np.percentile(voice[valid], 20)
    ref_active = valid_ref & ((ref >= ref_floor) & (ref > -70.0))
    active = valid & ((voice >= voice_floor) & (voice > -70.0))
    if np.count_nonzero(ref_active) < 4 or np.count_nonzero(active) < 4:
        return gains, {"method": "insufficient-active-frames"}

    ref_prominence = ref[ref_active] - orig[ref_active]
    current_prominence = voice + gains - backing
    target_global = float(np.median(ref_prominence))
    measured_global = float(np.median(current_prominence[active]))
    global_delta = target_global - measured_global

    # Match the original vocal-to-backing relationship across quiet and loud
    # sections. Bin the *original* backing by its own rank; its associated
    # vocal prominence is the target. Do not impose a linear gain/backing rule.
    ranks = np.linspace(0.0, 1.0, 9)
    original_edges = np.quantile(orig[ref_active], ranks)
    targets = np.empty(8, dtype=np.float64)
    for i in range(8):
        selection = ref_active & (orig >= original_edges[i]) & (
            (orig <= original_edges[i + 1]) if i == 7 else (orig < original_edges[i + 1])
        )
        targets[i] = np.median((ref - orig)[selection]) if np.any(selection) else target_global
    # Map the current accompaniment to its own distribution, so differently
    # mastered backing stems do not distort the matching.
    performance_edges = np.quantile(backing[active], ranks)
    indices = np.searchsorted(performance_edges[1:-1], backing, side="right")
    expected = targets[np.clip(indices, 0, 7)]
    desired = expected - current_prominence
    desired = np.where(valid, desired, 0.0)

    edges = np.diff(np.r_[False, active, False].astype(np.int8))
    starts, ends = np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)
    lengths = ends - starts
    frames = int(np.median(lengths)) if len(lengths) else 1
    window = max(3, min(len(gains) | 1, (frames // 2) | 1))
    slow = uniform_filter1d(median_filter(desired, size=window, mode="nearest"), size=window, mode="nearest")
    slow -= float(np.median(slow[active]))
    # Reference dynamics determine the allowed local adjustment, not a fixed
    # dB target. Keep phrase-to-phrase changes smooth and the global balance
    # independent of the local music level.
    variation = float(np.percentile(np.abs(ref_prominence - target_global), 75))
    slow = np.clip(slow, -variation, variation)
    weight = uniform_filter1d(active.astype(np.float64), size=window, mode="nearest")
    result = np.clip(gains + global_delta + slow * np.clip(weight, 0.0, 1.0), -18.0, _MAX_BOOST_DB)
    return result, {
        "method": "reference-backing-quantile-conditioned",
        "referenceProminenceDb": target_global,
        "performanceProminenceDb": measured_global,
        "globalCorrectionDb": float(global_delta),
        "referenceVariationDb": variation,
        "presenceBoostMaxDb": float(np.max(result - gains)),
    }


def _reference_compressor_timing(reference: NDArray[np.float64]) -> dict[str, float | str]:
    """Estimate response times from sustained reference-vocal level transitions.

    This is an envelope-based proxy, not identification of a studio compressor.
    Guardrails prevent pathological timings when a phrase has no usable edges.
    """
    values = np.asarray(reference, dtype=np.float64)
    values = values[np.isfinite(values)]
    if values.size < 30:
        return {"timingMethod": "insufficient-reference", "attackMs": 25.0, "releaseMs": 180.0}
    # Suppress individual syllable peaks; retain the phrase-level envelope.
    smooth = median_filter(values, size=3, mode="nearest")
    low, high = np.percentile(smooth, [20, 85])
    if high - low < 5:
        return {"timingMethod": "insufficient-contrast", "attackMs": 25.0, "releaseMs": 180.0}
    # Duration between 20% and 80% of each clearly rising/falling transition.
    lo = low + 0.2 * (high - low)
    hi = low + 0.8 * (high - low)
    rises, falls = [], []
    state = "low" if smooth[0] <= lo else "high" if smooth[0] >= hi else "middle"
    start = None
    for i, value in enumerate(smooth):
        if state == "low":
            if value > lo:
                state, start = "rising", i
        elif state == "rising":
            if value >= hi:
                rises.append((i - start + 1) * _PROFILE_SECONDS * 1000)
                state, start = "high", None
            elif value <= lo:
                state, start = "low", None
        elif state == "high":
            if value < hi:
                state, start = "falling", i
        elif state == "falling":
            if value <= lo:
                falls.append((i - start + 1) * _PROFILE_SECONDS * 1000)
                state, start = "low", None
            elif value >= hi:
                state, start = "high", None
        else:
            if value <= lo:
                state = "low"
            elif value >= hi:
                state = "high"
    if not rises or not falls:
        return {"timingMethod": "insufficient-transitions", "attackMs": 25.0, "releaseMs": 180.0}
    # Dynamics are slower than a 100ms RMS frame; estimate only broad behavior.
    # The FFmpeg compressor has its own permissible parameter ranges.
    attack = float(np.clip(np.median(rises) * 0.15, 5, 100))
    release = float(np.clip(np.median(falls) * 0.75, 50, 1000))
    return {"timingMethod": "reference-phrase-envelope", "attackMs": attack,
            "releaseMs": release, "risingEdges": len(rises), "fallingEdges": len(falls)}


def _reference_compression(
    recorded: NDArray[np.float64], reference: NDArray[np.float64]
) -> dict[str, float | str]:
    """Estimate vocal compression from the two recordings' *active* level spans.

    The original vocal is used only when its level distribution contains enough
    reliable active frames. This is an estimate, not recovery of a plugin preset.
    """
    def activity(levels: NDArray[np.float64]) -> NDArray[np.float64]:
        values = np.asarray(levels, dtype=np.float64)
        values = values[np.isfinite(values)]
        if values.size < 20:
            return np.empty(0, dtype=np.float64)
        low, high = np.percentile(values, [20, 85])
        return values[values > low + 0.35 * (high - low)]

    timing = _reference_compressor_timing(reference)
    voice, original = activity(recorded), activity(reference)
    if min(voice.size, original.size) < 10:
        return {"method": "insufficient-reference", "ratio": 1.0, "thresholdDb": float(np.median(recorded[np.isfinite(recorded)])) if np.any(np.isfinite(recorded)) else -60.0, **timing}
    v20, v90 = np.percentile(voice, [20, 90])
    r20, r90 = np.percentile(original, [20, 90])
    input_span = float(v90 - v20)
    target_span = float(r90 - r20)
    # Compression cannot increase dynamic range. Do not invent compression when
    # the reference is more dynamic than the recording.
    ratio = float(np.clip(input_span / max(target_span, 1e-6), 1.0, 3.0))
    return {
        "method": "reference-active-dynamics",
        "ratio": ratio,
        "thresholdDb": float(v20),
        "recordedRangeDb": input_span,
        "referenceRangeDb": target_span,
        **timing,
    }
