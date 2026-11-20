"""Reference balance anchored to audible word bands when both voices support them."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import threading

import numpy as np
import soundfile as sf

from backend.domain_errors import DependencyError
from backend.recordings.studio_adaptive_calibration import _periodicity, calibrate_gains
from backend.recordings.studio_adaptive_phrases import (
    MAX_RIDE_DB_PER_SECOND,
    WINDOW_SECONDS,
    phrase_core_masks,
    phrase_gain_targets,
    recording_presence_weights,
    section_ratio_errors,
    supported_reference_phrases,
)
from backend.recordings.studio_audio import _check_cancel, _profile

_STEP = 0.1


@dataclass(frozen=True, slots=True)
class BalancePlan:
    times: np.ndarray
    gains: np.ndarray
    active: np.ndarray
    report: dict[str, object]
    matched: np.ndarray
    reference_ratios: np.ndarray
    presence_weights: np.ndarray
    instrumental_rest: np.ndarray
    rest_music_level: float


@dataclass(frozen=True, slots=True)
class ReferenceAnchor:
    voice: np.ndarray
    reference: np.ndarray
    backing: np.ndarray
    music: np.ndarray
    matched: np.ndarray
    weights: np.ndarray
    report: dict[str, object]
    instrumental_rest: np.ndarray
    rest_music_level: float
    voice_active: np.ndarray
    reference_active: np.ndarray
    voice_core: np.ndarray
    reference_core: np.ndarray


def vocal_activity(levels: np.ndarray, dynamic_range: float = 36.0) -> np.ndarray:
    audible = levels[levels > -100]
    if not len(audible):
        return np.zeros(len(levels), dtype=bool)
    return levels > max(-90.0, float(np.percentile(audible, 95)) - dynamic_range)


def _lead_profile(path: Path, cancel: threading.Event) -> np.ndarray:
    full = _profile(path, cancel)
    if sf.info(path).channels != 2:
        return full
    mid = _profile(path, cancel, center=True)
    active = vocal_activity(full)
    return full if active.any() and np.median(full[active] - mid[active]) > 12 else mid


def _presence_profile(path: Path, cancel: threading.Event) -> np.ndarray:
    high = min(3500.0, sf.info(path).samplerate * 0.45)
    return _profile(path, cancel, voice_band=True, band_hz=(800.0, high), center=True)


def _band_noise_floor(band: np.ndarray, active: np.ndarray) -> tuple[float, float | None]:
    rests = band[~active]
    noise = float(np.median(rests)) if len(rests) >= 3 else None
    floor = max(-85.0, noise + 8) if noise is not None else -85.0
    return floor, noise


def _band_support(band: np.ndarray, full: np.ndarray) -> tuple[np.ndarray, dict[str, object]]:
    active = vocal_activity(full)
    floor, noise = _band_noise_floor(band, active)
    supported = active & (band - full >= -20) & (band > floor)
    relative = float(np.median((band - full)[active])) if active.any() else None
    return supported, {
        "minimumRelativeBandDb": -20.0,
        "minimumBandLevelDbfs": floor,
        "estimatedNoiseFloorDbfs": noise,
        "medianRelativeBandDb": relative,
    }


def _spectral_anchor(
    vocal: Path,
    reference: Path,
    voice: np.ndarray,
    expected: np.ndarray,
    cancel: threading.Event,
    *,
    presence: tuple[np.ndarray, np.ndarray] | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, dict[str, object]]:
    if presence is None:
        presence = _presence_profile(vocal, cancel), _presence_profile(reference, cancel)
    band, reference_band = presence
    supported, voice_report = _band_support(band, voice)
    reference_supported, reference_report = _band_support(reference_band, expected)
    active = vocal_activity(voice)
    reference_active = vocal_activity(expected, 24.0)
    weights = recording_presence_weights(
        voice, expected, active, reference_active, supported, reference_supported
    )
    trusted = supported_reference_phrases(active, reference_active, supported, reference_supported)
    if not np.any(weights):
        trusted[:] = True
    fraction = float(np.mean(weights[active] > 0.5)) if active.any() else 0.0
    for report in (voice_report, reference_report):
        report.update(
            presenceBandHz=[800.0, min(3500.0, sf.info(vocal).samplerate * 0.45)],
            presenceFraction=fraction,
            fallback="broadband-center-RMS",
        )
    return (
        voice + weights * (band - voice),
        expected + weights * (reference_band - expected),
        weights,
        trusted,
        {
            "voiceSpectralAnchor": voice_report,
            "referenceSpectralAnchor": reference_report,
            "anchorRegions": _anchor_regions(weights),
        },
    )


def _anchor_regions(weights: np.ndarray) -> list[dict[str, object]]:
    presence = weights > 0.5
    edges = np.flatnonzero(np.diff(np.r_[False, presence, False].astype(int)))
    return [
        {
            "startSeconds": float(start * _STEP),
            "endSeconds": float(end * _STEP),
            "bandHz": [800.0, 3500.0],
        }
        for start, end in zip(edges[::2], edges[1::2])
    ]


def _empty_anchor(voice: np.ndarray, music: np.ndarray) -> ReferenceAnchor:
    empty = np.zeros(len(voice))
    fallback: dict[str, object] = {
        "voiceSpectralAnchor": {"presenceFraction": 0.0},
        "referenceSpectralAnchor": {"presenceFraction": 0.0},
        "anchorRegions": [],
    }
    return ReferenceAnchor(
        voice,
        empty,
        empty,
        music,
        empty.astype(bool),
        empty,
        fallback,
        empty.astype(bool),
        0.0,
        vocal_activity(voice),
        empty.astype(bool),
        empty.astype(bool),
        empty.astype(bool),
    )


def _periodic_core_support(
    path: Path, candidates: np.ndarray, cancel: threading.Event
) -> np.ndarray:
    supported = np.zeros(len(candidates), dtype=bool)
    if not candidates.any():
        return supported
    with sf.SoundFile(path) as source:
        width = max(1, round(source.samplerate * _STEP))
        for index in np.flatnonzero(candidates):
            _check_cancel(cancel)
            source.seek(int(index * width))
            samples = source.read(width, always_2d=True, dtype="float64")
            # Presence levels measure the center lead. A periodic side voice
            # must not turn nonperiodic center residue into vocal evidence.
            center = samples.mean(axis=1, keepdims=True)
            supported[index] = _periodicity(center, source.samplerate) >= 0.8
    return supported


def _reference_core_masks(
    paths: tuple[Path, Path],
    levels: tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray],
    activity: tuple[np.ndarray, np.ndarray],
    weights: np.ndarray,
    cancel: threading.Event,
) -> tuple[np.ndarray, np.ndarray]:
    voice, expected, actual, desired = levels
    broad_cores = phrase_core_masks(voice, expected, *activity)
    cores = phrase_core_masks(actual, desired, *activity)
    # Preserve clear words, including aperiodic consonants. Extend their fixed
    # phrase core only for confirmed dark vowels, not loud low-frequency residue.
    for path, full, band, core, broad in zip(
        paths, (voice, expected), (actual, desired), cores, broad_cores, strict=True
    ):
        floor, _ = _band_noise_floor(band, vocal_activity(full))
        above_noise = (weights == 0) | (band > floor)
        core |= _periodic_core_support(path, broad & ~core & above_noise, cancel)
        core &= above_noise
    return cores


def _reference_anchor(
    vocal: Path,
    reference: Path | None,
    original: Path | None,
    voice: np.ndarray,
    music: np.ndarray,
    cancel: threading.Event,
) -> ReferenceAnchor:
    if reference is None or original is None:
        return _empty_anchor(voice, music)
    expected, backing = _lead_profile(reference, cancel), _profile(original, cancel)
    if len(expected) != len(voice) or len(backing) != len(voice):
        raise DependencyError(
            "StudioMasterStemMismatch", "Reference must cover the recording timeline"
        )
    voice_active, reference_active = vocal_activity(voice), vocal_activity(expected, 24.0)
    reference_active &= vocal_activity(music) == vocal_activity(backing)
    actual_music, reference_music, rests, scale = _music_anchor_levels(music, backing)
    actual, desired, weights, trusted, report = _spectral_anchor(
        vocal, reference, voice, expected, cancel
    )
    reference_active &= trusted
    levels = voice, expected, actual, desired
    core_masks = _reference_core_masks(
        (vocal, reference), levels, (voice_active, reference_active), weights, cancel
    )
    return ReferenceAnchor(
        actual,
        desired,
        reference_music,
        actual_music,
        voice_active & reference_active,
        weights,
        report,
        rests,
        scale,
        voice_active,
        reference_active,
        *core_masks,
    )


def _music_anchor_levels(
    music: np.ndarray,
    reference: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, float]:
    audible, expected = vocal_activity(music), vocal_activity(reference)
    paired = audible & expected
    scale = float(np.median((music - reference)[paired])) if paired.any() else 0.0
    rests = ~audible & ~expected
    # In an a-cappella section, continue the calibrated vocal level. Dividing by
    # a disappearing backing would manufacture a gain jump or amplify its noise.
    return np.where(rests, scale, music), np.where(rests, 0.0, reference), rests, scale


def _desired_gains(times: np.ndarray, anchor: ReferenceAnchor, enabled: bool) -> np.ndarray:
    if not enabled:
        return np.zeros(len(times))
    return phrase_gain_targets(
        anchor.voice,
        anchor.reference,
        anchor.music - anchor.backing,
        anchor.voice_active,
        anchor.voice_core,
        anchor.reference_core,
        anchor.matched,
    )


def _gain_statistics(
    gains: np.ndarray, requested: np.ndarray, active: np.ndarray
) -> dict[str, object]:
    return {
        "medianGainDb": float(np.median(gains[active])) if active.any() else 0.0,
        "minGainDb": float(np.min(gains, initial=0)),
        "maxGainDb": float(np.max(gains, initial=0)),
        "activeSeconds": float(np.count_nonzero(active) * _STEP),
        "limitedFraction": float(np.mean(abs(requested[active] - gains[active]) > 0.1))
        if active.any()
        else 0.0,
        "gainApplications": 1,
    }


def _balance_report(
    anchor: ReferenceAnchor,
    active: np.ndarray,
    gains: np.ndarray,
    requested: np.ndarray,
    enabled: bool,
    coverage: float,
) -> dict[str, object]:
    ratios = anchor.reference - anchor.backing
    return {
        "method": "absolute-reference-center-vocal-to-backing-ratio"
        if enabled
        else "preserve-capture-balance-without-reliable-reference",
        "automationMethod": "phrase-reference-vocal-and-common-backing-calibration",
        "levelMeasure": "phrase-core-medians-with-recording-spectral-anchor",
        "phraseCoreMeasure": "word-band-or-confirmed-dark-vowels-with-band-noise-rejection",
        "balanceWindowSeconds": WINDOW_SECONDS,
        "maxLocalRideDbPerSecond": MAX_RIDE_DB_PER_SECOND,
        "referenceEndBehavior": "hold-current-phrase-gain-and-preserve-input-calibration",
        "referenceTargetRatioDb": float(np.median(ratios[anchor.matched])) if enabled else None,
        "referenceUsed": enabled,
        "referenceMatchedFraction": coverage,
        "referenceMatchedSeconds": float(np.count_nonzero(anchor.matched) * _STEP),
        "instrumentalRestSeconds": float(
            np.count_nonzero(anchor.instrumental_rest & anchor.matched) * _STEP
        ),
        "referenceCaveat": "center stem is a lead proxy; coincident harmonies remain ambiguous",
        **_gain_statistics(gains, requested, active),
        **anchor.report,
    }


def plan_balance(
    vocal: Path,
    backing: Path,
    reference_vocal: Path | None,
    reference_backing: Path | None,
    cancel: threading.Event,
) -> BalancePlan:
    voice, music = _lead_profile(vocal, cancel), _profile(backing, cancel)
    if len(voice) != len(music):
        raise DependencyError("StudioMasterStemMismatch", "Mix profiles have different durations")
    times = (np.arange(len(voice)) + 0.5) * _STEP
    active = vocal_activity(voice)
    anchor = _reference_anchor(vocal, reference_vocal, reference_backing, voice, music, cancel)
    coverage = int(np.count_nonzero(anchor.matched)) / max(int(np.count_nonzero(active)), 1)
    enabled = bool(anchor.matched.any() and coverage >= 0.35)
    requested = _desired_gains(times, anchor, enabled)
    gains, calibration = calibrate_gains(vocal, voice, requested, anchor.matched & enabled, cancel)
    report = _balance_report(anchor, active, gains, requested, enabled, coverage)
    report.update(calibration)
    return BalancePlan(
        times,
        gains,
        active,
        report,
        anchor.matched,
        anchor.reference - anchor.backing,
        anchor.weights,
        anchor.instrumental_rest,
        anchor.rest_music_level,
    )


def measure_balance(
    plan: BalancePlan,
    vocal: Path,
    backing: Path,
    cancel: threading.Event,
) -> dict[str, object]:
    if not plan.report["referenceUsed"]:
        return {"p90ReferenceRatioErrorDb": None, "medianReferenceRatioErrorDb": None}
    voice, music = _lead_profile(vocal, cancel), _profile(backing, cancel)
    music[plan.instrumental_rest] = plan.rest_music_level
    if np.any(plan.presence_weights > 0):
        voice += plan.presence_weights * (_presence_profile(vocal, cancel) - voice)
    errors = abs((voice - music - plan.reference_ratios)[plan.matched])
    sections = section_ratio_errors(voice, music, plan.reference_ratios, plan.matched)
    return {
        "p90ReferenceRatioErrorDb": float(np.percentile(errors, 90)),
        "medianReferenceRatioErrorDb": float(np.median(errors)),
        "p90SectionReferenceRatioErrorDb": float(np.percentile(sections, 90))
        if len(sections)
        else None,
        "medianSectionReferenceRatioErrorDb": float(np.median(sections)) if len(sections) else None,
        "comparisonWindowSeconds": WINDOW_SECONDS,
        "measurementStage": "rendered-balanced-dry-vocal-and-ducked-backing",
    }
