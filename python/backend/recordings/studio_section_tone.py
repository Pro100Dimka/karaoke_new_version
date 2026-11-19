"""Measured regional vocal tone, linked in stereo and separate from level calibration."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import math
import shutil
import threading

import numpy as np
from numpy.typing import NDArray
from scipy.ndimage import gaussian_filter1d
from scipy.signal import sosfilt
import soundfile as sf

from backend.domain_errors import DependencyError
from backend.recordings.studio_adaptive_balance import (
    _lead_profile,
    _reference_core_masks,
    _spectral_anchor,
    vocal_activity,
)
from backend.recordings.studio_arrangement import ArrangementMap
from backend.recordings.studio_audio import _check_cancel, _profile, _temporary_wave

FloatArray = NDArray[np.float64]
BoolArray = NDArray[np.bool_]


@dataclass(frozen=True, slots=True)
class SectionVoice:
    full: FloatArray
    body: FloatArray
    lower_words: FloatArray
    words: FloatArray
    active: BoolArray
    core: BoolArray


@dataclass(frozen=True, slots=True)
class SectionEvidence:
    times: FloatArray
    own: SectionVoice
    reference: SectionVoice
    valid: BoolArray
    stable: BoolArray


def context_mask(times: FloatArray, arrangement: ArrangementMap, values: BoolArray) -> BoolArray:
    if not len(values):
        return np.zeros(len(times), dtype=bool)
    return np.asarray(
        np.interp(times, arrangement.times, values.astype(float), left=values[0], right=values[-1])
        >= 0.5
    )


def _voice_levels(
    path: Path, cancel: threading.Event
) -> tuple[FloatArray, FloatArray, FloatArray, FloatArray]:
    return (
        _lead_profile(path, cancel),
        _profile(path, cancel, voice_band=True, band_hz=(80.0, 800.0), center=True),
        _profile(path, cancel, voice_band=True, band_hz=(800.0, 1500.0), center=True),
        _profile(path, cancel, voice_band=True, band_hz=(1500.0, 3500.0), center=True),
    )


def section_evidence(
    vocal: Path, reference: Path, arrangement: ArrangementMap, cancel: threading.Event
) -> SectionEvidence:
    _check_cancel(cancel)
    info = sf.info(vocal)
    if (info.frames, info.samplerate) != (arrangement.frames, arrangement.rate):
        raise DependencyError("StudioMasterStemMismatch", "Vocal and arrangement timelines differ")
    full, body, lower, words = _voice_levels(vocal, cancel)
    expected, ref_body, ref_lower, ref_words = _voice_levels(reference, cancel)
    if len(expected) != len(full):
        raise DependencyError("StudioMasterStemMismatch", "Reference does not cover the vocal")
    width = max(1, round(info.samplerate * 0.1))
    starts = np.arange(len(full)) * width
    times = np.asarray((starts + np.minimum(width, info.frames - starts) / 2) / info.samplerate)
    valid = context_mask(times, arrangement, arrangement.reference_valid)
    actual, desired, weights, trusted, _ = _spectral_anchor(
        vocal, reference, full, expected, cancel
    )
    active, ref_active = vocal_activity(full), vocal_activity(expected, 24.0) & valid & trusted
    own_core, ref_core = _reference_core_masks(
        (vocal, reference), (full, expected, actual, desired), (active, ref_active), weights, cancel
    )
    return SectionEvidence(
        times,
        SectionVoice(full, body, lower, words, active, own_core),
        SectionVoice(expected, ref_body, ref_lower, ref_words, ref_active, ref_core),
        valid,
        context_mask(times, arrangement, arrangement.stable_anchor),
    )


def _band_noise_floor(voice: SectionVoice, levels: FloatArray) -> float | None:
    quiet = (
        voice.full < float(np.median(voice.full[voice.active])) - 24
        if voice.active.any()
        else np.zeros(len(voice.full), dtype=bool)
    )
    return float(np.percentile(levels[quiet], 90)) if np.count_nonzero(quiet) >= 3 else None


def _word_noise_floor(voice: SectionVoice) -> float | None:
    return _band_noise_floor(voice, voice.words)


def band_support(voice: SectionVoice, levels: FloatArray) -> BoolArray:
    floor = _band_noise_floor(voice, levels)
    if floor is not None:
        return voice.active & (levels > max(-85.0, floor + 8))
    return voice.active & (levels > -85) & (levels - voice.full > -24)


def word_support(voice: SectionVoice) -> BoolArray:
    return band_support(voice, voice.words)


def section_selection(region: BoolArray, common: BoolArray, stable: BoolArray) -> BoolArray:
    selected = region & common
    anchor = selected & stable
    minimum = min(20, int(np.count_nonzero(region)))
    return anchor if np.count_nonzero(anchor) >= minimum else selected


def _bright_allowance(
    evidence: SectionEvidence, selected: BoolArray
) -> tuple[float, dict[str, object]]:
    values: list[float | None] = []
    for voice in (evidence.own, evidence.reference):
        floor = _word_noise_floor(voice)
        values.append(
            float(np.percentile(voice.words[selected], 25)) - floor
            if floor is not None and selected.any()
            else None
        )
    confirmed = all(value is not None and value >= 12 for value in values)
    limit = 8.0 if confirmed else 4.0
    return limit, {
        "ownWordBandSnr25Db": values[0],
        "referenceWordBandSnr25Db": values[1],
        "positiveTiltLimitDb": limit,
        "noiseMethod": "quiet-word-band-p90-and-supported-word-p25",
    }


def _tone_plan(
    evidence: SectionEvidence, arrangement: ArrangementMap
) -> tuple[FloatArray, list[dict[str, object]]]:
    own, expected = evidence.own, evidence.reference
    common = own.core & expected.core & evidence.valid & word_support(own) & word_support(expected)
    curve = np.zeros(len(evidence.times))
    reports: list[dict[str, object]] = []
    for section in arrangement.sections:
        region = (evidence.times >= section.start_seconds) & (evidence.times < section.end_seconds)
        selected = section_selection(region, common, evidence.stable)
        supported = int(np.count_nonzero(selected)) >= min(20, int(np.count_nonzero(region)))
        difference = (
            float(np.median((expected.words - expected.body)[selected]))
            - float(np.median((own.words - own.body)[selected]))
            if supported and selected.any()
            else 0.0
        )
        limit, confidence = _bright_allowance(evidence, selected)
        tilt = float(np.clip(difference, -4, limit))
        curve[region] = tilt
        reports.append(
            {
                "startSeconds": section.start_seconds,
                "endSeconds": section.end_seconds,
                "referenceToneDifferenceDb": difference,
                "toneTiltDb": tilt,
                "bodyEqDb": -tilt / 2,
                "presenceEqDb": tilt / 2,
                "supportedSeconds": float(np.count_nonzero(selected) * 0.1),
                **confidence,
            }
        )
    return np.asarray(gaussian_filter1d(curve, 6, mode="nearest"), dtype=np.float64), reports


def _peaking(rate: int, frequency: float, gain: float) -> FloatArray:
    a, omega = 10 ** (gain / 40), 2 * math.pi * frequency / rate
    alpha = math.sin(omega) / (2 * 0.7)
    row = np.asarray(
        [
            1 + alpha * a,
            -2 * math.cos(omega),
            1 - alpha * a,
            1 + alpha / a,
            -2 * math.cos(omega),
            1 - alpha / a,
        ]
    )
    return np.asarray(row[None, :] / row[3], dtype=np.float64)


def _tone_banks(rate: int) -> tuple[FloatArray, ...]:
    presence = min(2400.0, rate * 0.35)
    return tuple(
        np.vstack((_peaking(rate, 350, -gain), _peaking(rate, presence, gain)))
        for gain in (2.0, 4.0, -2.0)
    )


def _write_tone(
    source: Path, target: Path, times: FloatArray, curve: FloatArray, cancel: threading.Event
) -> None:
    info = sf.info(source)
    bright, strong, warm = _tone_banks(info.samplerate)
    bright_state, strong_state, warm_state = (np.zeros((2, 2, info.channels)) for _ in range(3))
    offset = 0
    with (
        sf.SoundFile(source) as audio,
        _temporary_wave(target, samplerate=info.samplerate, channels=info.channels) as output,
    ):
        for block in audio.blocks(blocksize=65536, dtype="float64", always_2d=True):
            _check_cancel(cancel)
            raised, bright_state = sosfilt(bright, block, axis=0, zi=bright_state)
            stronger, strong_state = sosfilt(strong, block, axis=0, zi=strong_state)
            softened, warm_state = sosfilt(warm, block, axis=0, zi=warm_state)
            positions = (offset + np.arange(len(block))) / info.samplerate
            amount = np.interp(positions, times, curve)[:, None]
            mixed = block + np.clip(amount, 0, 4) / 4 * (raised - block)
            mixed += np.maximum(amount - 4, 0) / 4 * (stronger - raised)
            mixed += np.maximum(-amount, 0) / 4 * (softened - block)
            output.write(mixed)
            offset += len(block)


def render_section_tone(
    source: Path,
    target: Path,
    reference: Path | None,
    arrangement: ArrangementMap,
    cancel: threading.Event,
) -> dict[str, object]:
    _check_cancel(cancel)
    target.parent.mkdir(parents=True, exist_ok=True)
    if reference is None or not arrangement.reference_valid.any():
        shutil.copyfile(source, target)
        return {"applied": False, "reason": "no-reference-tone-evidence"}
    evidence = section_evidence(source, reference, arrangement, cancel)
    curve, sections = _tone_plan(evidence, arrangement)
    applied = bool(np.max(abs(curve), initial=0) >= 0.05)
    if applied:
        _write_tone(source, target, evidence.times, curve, cancel)
    else:
        _check_cancel(cancel)
        shutil.copyfile(source, target)
    return {
        "applied": applied,
        "method": "regional-linked-body-and-word-band-eq",
        "bodyHz": 350.0,
        "presenceHz": min(2400.0, arrangement.rate * 0.35),
        "q": 0.7,
        "maxGainPerBandDb": 4.0,
        "maxPresenceCutDb": 2.0,
        "strongerPresenceMinimumSnrDb": 12.0,
        "transitionSeconds": 0.6,
        "sections": sections,
        "levelCompensation": "remeasure-post-tone-vocal-in-section-balance",
        "stereoLinked": True,
        "floatHeadroomPreserved": True,
    }
