from __future__ import annotations
from pathlib import Path
import math
import threading
import numpy as np
from numpy.typing import NDArray
from scipy.ndimage import gaussian_filter1d, median_filter, minimum_filter1d, uniform_filter1d
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
    """Slow, activity-gated vocal rides for songs that build to a climax.

    All inputs are 100 ms RMS profiles in dBFS. Never amplify rests, avoid
    following drum transients, and preserve the musical rise of the singer.
    """
    if not (len(gains) and len(gains) == len(voice) == len(backing)):
        return gains, {"presenceBoostMaxDb": 0.0, "presenceBoostMeanDb": 0.0}
    if not all(np.isfinite(x).all() for x in (gains, voice, backing)):
        return gains, {"presenceBoostMaxDb": 0.0, "presenceBoostMeanDb": 0.0}

    floor = min(float(np.percentile(voice, 80)) - 6.0,
                max(-48.0, float(np.percentile(voice, 20)) + 9.0))
    active = voice > floor
    if np.count_nonzero(active) < 10:
        return gains, {"presenceBoostMaxDb": 0.0, "presenceBoostMeanDb": 0.0}

    # Offline, non-causal analysis: the music envelope can be anticipated before
    # a crescendo. A broad median ignores individual drums and transient hits.
    music = median_filter(backing, size=31, mode="nearest")
    vocal = median_filter(voice + gains, size=15, mode="nearest")
    baseline = float(np.percentile(music[active], 35))
    rise = np.clip(music - baseline, 0.0, 12.0)
    relative = vocal - music
    typical = float(np.percentile(relative[active], 60))
    deficit = np.clip(typical - relative - 2.0, 0.0, 5.0)

    # A soft dead band prevents a gain jump when the music crosses a threshold.
    # A low-level hysteresis envelope suppresses gain chatter around that band.
    raw = np.minimum(5.0, np.maximum(0.5 * rise, 0.6 * deficit))
    raw = np.clip((raw - 0.45) / 0.9, 0.0, 1.0) * raw
    hysteresis = np.empty_like(raw)
    hysteresis[0] = raw[0]
    for index in range(1, len(raw)):
        difference = raw[index] - hysteresis[index - 1]
        if abs(difference) < 0.12:
            hysteresis[index] = hysteresis[index - 1]
        else:
            hysteresis[index] = hysteresis[index - 1] + np.clip(difference, -0.18, 0.18)

    # Smooth over ~4 s on both sides; this is an offline render, so looking
    # ahead does not add playback latency. Use the same curve on the way down.
    desired = gaussian_filter1d(hysteresis, sigma=20, mode="nearest")
    # Only amplify audible phrases. Smooth gates avoid syllable-by-syllable pumping.
    activity = gaussian_filter1d(active.astype(float), sigma=4, mode="nearest")
    gate = np.clip((activity - 0.12) / 0.7, 0.0, 1.0)
    gate = gate * gate * (3.0 - 2.0 * gate)
    desired *= gate
    extra = np.clip(np.minimum(desired, np.maximum(0.0, _MAX_BOOST_DB - gains)), 0.0, 5.0)
    result = gains + extra
    return result, {
        "presenceBoostMaxDb": float(np.max(extra)),
        "presenceBoostMeanDb": float(np.mean(extra[active])),
        "backingReferenceDbfs": baseline,
        "presenceTargetRelativeDb": typical,
        "presenceAlgorithm": "offline-lookahead-smooth-hysteresis-v3",
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
        _clarity_filters(ratios, filters, reference_ratio, 0 if cuts else None)
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
    # Compare broad envelopes, not individual harmonics or the singers' absolute levels.
    excess = _tone_envelope(centers, frames) - np.interp(centers, reference[1], reference[2])
    report: dict[str, object] = {}
    for name, lower, upper, limit in (("body", 250, 700, 3), ("presence", 1800, 4200, 2)):
        indices = np.flatnonzero((centers >= lower) & (centers <= upper))
        index = int(indices[np.argmax(excess[indices])])
        reduction = float(min(excess[index] * 0.5, limit)) if excess[index] > 2 else 0.0
        frequency = float(centers[index])
        if reduction:
            filters.append(f"equalizer=f={frequency:.3f}:t=q:w=0.7:g={-reduction:.6f}")
        report[f"{name}ReductionDb"] = reduction
        report[f"{name}FrequencyHz"] = frequency if reduction else None
    return report


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


def _guard_global_vocal_balance(
    gains: NDArray[np.float64],
    voice: NDArray[np.float64],
    backing: NDArray[np.float64],
) -> tuple[NDArray[np.float64], dict[str, float | str]]:
    """Keep the overall vocal from dominating, without flattening phrase dynamics.

    Use only singing frames and a robust percentile, never full-song silence.
    Preserve the local ride shape and apply one constant corrective offset.
    """
    if not (len(gains) == len(voice) == len(backing) and len(gains)) or not all(
        np.isfinite(values).all() for values in (gains, voice, backing)
    ):
        return gains, {"status": "invalid-profile"}
    threshold = min(float(np.percentile(voice, 80)) - 6.0,
                    max(-48.0, float(np.percentile(voice, 20)) + 9.0))
    active = (voice > threshold) & (backing > -65.0)
    if np.count_nonzero(active) < 12:
        return gains, {"status": "insufficient-activity"}
    relative = voice[active] + gains[active] - backing[active]
    # A soft upper ceiling: tolerate short expressive peaks, but not a vocal
    # that consistently towers over the accompaniment. dBFS is a proxy, not LUFS.
    median = float(np.median(relative))
    upper = float(np.percentile(relative, 75))
    correction = float(np.clip(min(0.0, 5.0 - median, 8.0 - upper), -9.0, 0.0))
    result = gains + correction
    return result, {
        "status": "applied" if correction < -0.01 else "within-range",
        "globalCorrectionDb": correction,
        "vocalToBackingMedianBeforeDb": median,
        "vocalToBackingP75BeforeDb": upper,
        "vocalToBackingMedianAfterDb": median + correction,
    }
