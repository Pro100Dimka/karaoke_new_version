"""Regional vocal level anchors and a bounded rider of the singer's own phrasing."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import math
import threading

import numpy as np
from scipy.ndimage import gaussian_filter1d

from backend.domain_errors import DependencyError
from backend.recordings.studio_adaptive_balance import (
    BalancePlan,
    _music_anchor_levels,
    plan_balance,
)
from backend.recordings.studio_adaptive_calibration import calibrate_gains
from backend.recordings.studio_adaptive_phrases import _core
from backend.recordings.studio_arrangement import ArrangementMap
from backend.recordings.studio_audio import _check_cancel, _profile
from backend.recordings.studio_section_tone import (
    BoolArray,
    FloatArray,
    SectionEvidence,
    SectionVoice,
    band_support,
    section_evidence,
    section_selection,
    word_support,
    render_section_tone as render_section_tone,
)

_WORD_RESIDUAL_DB = 1.5
_SECTION_OFFSET_DB = 6.0
_PHRASE_RIDE_DB = 3.0


@dataclass(frozen=True, slots=True)
class _Music:
    actual: FloatArray
    reference: FloatArray
    word_scale: FloatArray
    body_scale: FloatArray
    lower_word_scale: FloatArray
    rest: BoolArray
    rest_level: float


def _band_scale(
    actual: Path,
    reference: Path,
    band: tuple[float, float],
    rest: BoolArray,
    cancel: threading.Event,
) -> FloatArray:
    first = _profile(actual, cancel, voice_band=True, band_hz=band)
    second = _profile(reference, cancel, voice_band=True, band_hz=band)
    difference = first - second
    typical = float(np.median(difference[~rest])) if (~rest).any() else 0.0
    return np.asarray(np.where(rest, typical, difference), dtype=np.float64)


def _music_profiles(backing: Path, reference: Path, cancel: threading.Event) -> _Music:
    actual, expected = _profile(backing, cancel), _profile(reference, cancel)
    if len(actual) != len(expected):
        raise DependencyError("StudioMasterStemMismatch", "Backing and reference timelines differ")
    actual, expected, rest, level = _music_anchor_levels(actual, expected)
    return _Music(
        actual,
        expected,
        _band_scale(backing, reference, (1500.0, 3500.0), rest, cancel),
        _band_scale(backing, reference, (80.0, 800.0), rest, cancel),
        _band_scale(backing, reference, (800.0, 1500.0), rest, cancel),
        rest,
        level,
    )


def _relative_level(
    voice: FloatArray, reference: FloatArray, music_scale: FloatArray, selected: BoolArray
) -> float:
    return float(
        np.median(reference[selected])
        - np.median(voice[selected])
        + np.median(music_scale[selected])
    )


def _capture_anchor(
    evidence: SectionEvidence, music: _Music, selected: BoolArray, full: float
) -> tuple[float, dict[str, object]]:
    own, expected = evidence.own, evidence.reference
    own_bands = (own.body, own.lower_words, own.words)
    reference_bands = (expected.body, expected.lower_words, expected.words)
    scales = (music.body_scale, music.lower_word_scale, music.word_scale)
    joint = selected.copy()
    for actual, reference in zip(own_bands, reference_bands, strict=True):
        joint &= band_support(own, actual) & band_support(expected, reference)
    sufficient = int(np.count_nonzero(joint)) >= min(20, int(np.count_nonzero(selected)))
    gains = (
        [_relative_level(a, r, s, joint) for a, r, s in zip(own_bands, reference_bands, scales)]
        if sufficient and joint.any()
        else []
    )
    agreement = float(np.min(np.diff(np.sort(gains)))) if gains else None
    supported = agreement is not None and agreement <= 3.0
    anchor = float(np.median(gains)) if supported else full
    return anchor, {
        "captureAnchorMethod": "take-wide-supported-band-consensus"
        if supported
        else "full-level-fallback",
        "captureBandTargetsDb": dict(zip(("body", "lowerWords", "words"), gains)),
        "captureBandSupportSeconds": float(np.count_nonzero(joint) * 0.1),
        "captureClosestBandAgreementDb": agreement,
        "captureAnchorGainDb": anchor,
        "captureAnchorFallbackReason": None
        if supported
        else ("insufficient-joint-band-evidence" if not gains else "divergent-band-level-targets"),
        "captureBandScope": "one-calibration-for-the-whole-performed-take",
    }


def _level_target(
    evidence: SectionEvidence, music: _Music, selected: BoolArray
) -> tuple[float, float, dict[str, object]]:
    own, expected = evidence.own, evidence.reference
    full = _relative_level(own.full, expected.full, music.actual - music.reference, selected)
    anchor, detail = _capture_anchor(evidence, music, selected, full)
    words = selected & word_support(own) & word_support(expected)
    supported = int(np.count_nonzero(words)) >= min(20, int(np.count_nonzero(selected)))
    word = (
        _relative_level(own.words, expected.words, music.word_scale, words) if supported else anchor
    )
    residual = float(np.clip(word - anchor, -_WORD_RESIDUAL_DB, _WORD_RESIDUAL_DB))
    return (
        anchor + residual,
        full,
        {
            **detail,
            "captureFullLevelTargetDb": full,
            "captureWordLevelTargetDb": word,
            "captureWordResidualDb": residual,
            "captureWordEvidenceUsed": bool(supported),
            "captureRequestedGainDb": anchor + residual,
        },
    )


def _own_phrase_rider(voice: SectionVoice, region: BoolArray) -> FloatArray:
    result = np.zeros(len(voice.full))
    indices = np.flatnonzero(region)
    if not len(indices):
        return result
    # The local control sees only this singer's full level. Reference phonemes
    # cannot change its target, and a quiet phrase retains its expression.
    core = np.zeros(len(voice.full), dtype=bool)
    core[region] = _core(voice.full[region], voice.active[region])
    if not core.any():
        return result
    target, previous = float(np.median(voice.full[core])), 0.0
    for index in indices:
        context = np.arange(max(indices[0], index - 20), min(indices[-1] + 1, index + 21))
        supported = context[core[context]]
        if voice.active[index] and len(supported) >= min(5, len(context)):
            deviation = target - float(np.median(voice.full[supported]))
            previous = float(np.clip(deviation * 0.65, -_PHRASE_RIDE_DB, _PHRASE_RIDE_DB))
        result[index] = previous
    return result


def _regional_targets(
    evidence: SectionEvidence, music: _Music, arrangement: ArrangementMap, common: BoolArray
) -> tuple[FloatArray, FloatArray, list[dict[str, object]], dict[str, object]]:
    capture, full, calibration = _level_target(evidence, music, common)
    base, rider = np.full(len(common), capture), np.zeros(len(common))
    reports: list[dict[str, object]] = []
    for section in arrangement.sections:
        region = (evidence.times >= section.start_seconds) & (evidence.times < section.end_seconds)
        selected = section_selection(region, common, evidence.stable)
        supported = int(np.count_nonzero(selected)) >= min(20, int(np.count_nonzero(region)))
        local_full = (
            _relative_level(
                evidence.own.full, evidence.reference.full, music.actual - music.reference, selected
            )
            if supported and selected.any()
            else full
        )
        target = capture + float(
            np.clip(local_full - full, -_SECTION_OFFSET_DB, _SECTION_OFFSET_DB)
        )
        base[region] = target
        if supported:
            rider += _own_phrase_rider(evidence.own, region)
        reports.append(
            {
                "startSeconds": section.start_seconds,
                "endSeconds": section.end_seconds,
                "baseGainDb": target,
                "fullLevelTargetDb": local_full,
                "sectionLevelAdjustmentDb": target - capture,
                "referenceSupported": bool(supported),
                "supportedSeconds": float(np.count_nonzero(selected) * 0.1),
            }
        )
    return base, rider, reports, calibration


def _gain_curve(base: FloatArray, rider: FloatArray, times: FloatArray) -> FloatArray:
    desired = gaussian_filter1d(base, 6, mode="nearest") + gaussian_filter1d(
        rider, 4, mode="nearest"
    )
    for index in range(1, len(desired)):
        step = 2.0 * (times[index] - times[index - 1])
        desired[index] = np.clip(
            desired[index], desired[index - 1] - step, desired[index - 1] + step
        )
    return np.asarray(desired, dtype=np.float64)


def _reference_coverage(evidence: SectionEvidence) -> float:
    matched = evidence.own.active & evidence.reference.active & evidence.valid
    return int(np.count_nonzero(matched)) / max(1, int(np.count_nonzero(evidence.own.active)))


def _reference_supported(evidence: SectionEvidence, common: BoolArray) -> bool:
    active_frames = int(np.count_nonzero(evidence.own.active))
    minimum = min(20, max(1, math.ceil(0.35 * active_frames)))
    return int(np.count_nonzero(common)) >= minimum and _reference_coverage(evidence) >= 0.35


def _section_report(
    evidence: SectionEvidence,
    music: _Music,
    gains: FloatArray,
    requested: FloatArray,
    common: BoolArray,
    sections: list[dict[str, object]],
) -> dict[str, object]:
    active = evidence.own.active
    return {
        "method": "section-full-level-with-bounded-word-residual",
        "automationMethod": "regional-calibration-and-own-phrase-rider",
        "levelMeasure": "take-wide-capture-consensus-and-regional-full-level-differences",
        "referenceUsed": True,
        "referenceMatchedSeconds": float(np.count_nonzero(common) * 0.1),
        "referenceMatchedFraction": _reference_coverage(evidence),
        "referenceCoreFraction": int(np.count_nonzero(common)) / max(1, int(active.sum())),
        "referenceTargetRatioDb": float(
            np.median((evidence.reference.full - music.reference)[common])
        ),
        "balanceWindowSeconds": 4.0,
        "maxLocalRideDbPerSecond": 2.0,
        "maxOwnPhraseRideDb": _PHRASE_RIDE_DB,
        "maxWordResidualDb": _WORD_RESIDUAL_DB,
        "maxSectionOffsetDb": _SECTION_OFFSET_DB,
        "referencePhonemeEnvelopeCopied": False,
        "referenceEndBehavior": "hold-section-or-established-capture-calibration",
        "medianGainDb": float(np.median(gains[active])) if active.any() else 0.0,
        "minGainDb": float(np.min(gains)),
        "maxGainDb": float(np.max(gains)),
        "activeSeconds": float(np.count_nonzero(active) * 0.1),
        "gainApplications": 1,
        "limitedFraction": float(np.mean(abs(gains[active] - requested[active]) > 0.1))
        if active.any()
        else 0.0,
        "instrumentalRestSeconds": float(np.count_nonzero(music.rest & common) * 0.1),
        "sections": sections,
    }


def _capture_fallback(vocal: Path, backing: Path, cancel: threading.Event) -> BalancePlan:
    plan = plan_balance(vocal, backing, None, None, cancel)
    plan.report["method"] = "preserve-capture-without-supported-section-reference"
    return plan


def plan_section_balance(
    vocal: Path,
    backing: Path,
    reference_vocal: Path | None,
    reference_backing: Path | None,
    arrangement: ArrangementMap,
    cancel: threading.Event,
) -> BalancePlan:
    _check_cancel(cancel)
    if (
        reference_vocal is None
        or reference_backing is None
        or not arrangement.reference_valid.any()
    ):
        return _capture_fallback(vocal, backing, cancel)
    evidence = section_evidence(vocal, reference_vocal, arrangement, cancel)
    music = _music_profiles(backing, reference_backing, cancel)
    if len(evidence.times) != len(music.actual):
        raise DependencyError("StudioMasterStemMismatch", "Vocal and backing timelines differ")
    common = evidence.own.core & evidence.reference.core & evidence.valid
    if not _reference_supported(evidence, common):
        return _capture_fallback(vocal, backing, cancel)
    base, rider, sections, anchor = _regional_targets(evidence, music, arrangement, common)
    requested = _gain_curve(base, rider, evidence.times)
    gains, calibration = calibrate_gains(vocal, evidence.own.full, requested, common, cancel)
    report = _section_report(evidence, music, gains, requested, common, sections)
    report.update(anchor)
    report.update(calibration)
    return BalancePlan(
        evidence.times,
        gains,
        evidence.own.active,
        report,
        common,
        evidence.reference.full - music.reference,
        np.zeros(len(gains)),
        music.rest,
        music.rest_level,
    )
