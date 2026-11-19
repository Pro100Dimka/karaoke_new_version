"""Conservative structural context on the existing performed audio timeline.

Local self-similarity contrast uses the multisecond principle of Foote (ICME
2000), without a quadratic whole-song similarity matrix or semantic part names.
The map describes evidence; callers still gate gains and sends with the singer.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import threading

import numpy as np
from numpy.typing import NDArray
from scipy.ndimage import gaussian_filter1d, median_filter
from scipy.signal import find_peaks
import soundfile as sf

from backend.domain_errors import DependencyError
from backend.recordings.studio_adaptive_features import BAND_EDGES, regions
from backend.recordings.studio_audio import _check_cancel

FloatArray = NDArray[np.float64]
BoolArray = NDArray[np.bool_]
_STEP = 0.25


@dataclass(frozen=True, slots=True)
class ArrangementSection:
    start_seconds: float
    end_seconds: float
    confidence: float
    repeat_group: int | None
    anchor_start_seconds: float | None
    anchor_end_seconds: float | None

    def payload(self) -> dict[str, object]:
        return {
            "startSeconds": self.start_seconds,
            "endSeconds": self.end_seconds,
            "confidence": self.confidence,
            "repeatGroup": self.repeat_group,
            "anchorStartSeconds": self.anchor_start_seconds,
            "anchorEndSeconds": self.anchor_end_seconds,
        }


@dataclass(frozen=True, slots=True)
class ArrangementMap:
    frames: int
    rate: int
    duration_seconds: float
    times: FloatArray
    density: FloatArray
    voice_priority: FloatArray
    vocal_activity: BoolArray
    reference_valid: BoolArray
    stable_anchor: BoolArray
    sections: tuple[ArrangementSection, ...]

    def payload(self) -> dict[str, object]:
        return {
            "method": "persistent-local-similarity-and-reference-occupancy",
            "timebase": "performed-timeline-seconds-from-zero",
            "durationSeconds": self.duration_seconds,
            "frames": self.frames,
            "sampleRate": self.rate,
            "referenceAvailable": bool(self.reference_valid.any()),
            "referenceCoverageFraction": float(np.mean(self.reference_valid)),
            "sections": [section.payload() for section in self.sections],
            "timesSeconds": self.times.tolist(),
            "density": self.density.tolist(),
            "voicePriority": self.voice_priority.tolist(),
            "vocalActivity": self.vocal_activity.tolist(),
            "referenceValid": self.reference_valid.tolist(),
            "stableAnchor": self.stable_anchor.tolist(),
            "caveat": "acoustic context and possible repetition; effect identity needs local evidence",
        }


@dataclass(frozen=True, slots=True)
class _Features:
    levels: FloatArray
    bands: FloatArray
    chroma: FloatArray
    widths: FloatArray
    valid: BoolArray


def _unit(values: FloatArray) -> FloatArray:
    return np.asarray(values / np.maximum(np.linalg.norm(values, axis=-1, keepdims=True), 1e-20))


def _stereo_width(samples: FloatArray) -> float:
    if samples.shape[1] != 2:
        return 0.0
    left, right = samples[:, 0], samples[:, 1]
    denominator = float(np.sqrt(np.sum(left**2) * np.sum(right**2)))
    if denominator < 1e-20:
        return 0.0
    return float(np.clip(1 - abs(float(np.sum(left * right))) / denominator, 0, 1))


def _frame_features(samples: FloatArray, rate: int) -> tuple[float, FloatArray, FloatArray, float]:
    if not np.isfinite(samples).all():
        raise DependencyError("StudioMasterInvalidAudio", "Audio contains non-finite samples")
    level = float(10 * np.log10(max(1e-12, float(np.mean(samples**2)))))
    centered = samples - samples.mean(axis=0, keepdims=True)
    window = np.hanning(len(samples))[:, None]
    # Power aggregation preserves opposite-phase stereo and channel gain invariance.
    power = np.mean(abs(np.fft.rfft(centered * window, axis=0)) ** 2, axis=1)
    hz = np.fft.rfftfreq(len(samples), 1 / rate)
    bands = np.asarray([power[(hz >= low) & (hz < high)].sum() for low, high in BAND_EDGES])
    bands = np.sqrt(bands / max(float(bands.sum()), 1e-24))
    pitched = (hz >= 60) & (hz <= min(4000, rate * 0.48))
    notes = np.rint(69 + 12 * np.log2(hz[pitched] / 440)).astype(int) % 12
    chroma = np.bincount(notes, weights=power[pitched], minlength=12).astype(np.float64)
    return level, bands, _unit(np.sqrt(chroma)), _stereo_width(centered)


def _read_features(
    path: Path | None, count: int, duration: float, cancel: threading.Event
) -> _Features:
    levels, bands, chroma = np.full(count, -120.0), np.zeros((count, 8)), np.zeros((count, 12))
    widths = np.zeros(count)
    valid = np.zeros(count, dtype=bool)
    if path is None:
        return _Features(levels, bands, chroma, widths, valid)
    with sf.SoundFile(path) as source:
        if source.samplerate < 1000:
            raise DependencyError("StudioMasterInvalidAudio", "Audio sample rate is invalid")
        for index in range(count):
            _check_cancel(cancel)
            start = round(index * _STEP * source.samplerate)
            end = round(min((index + 1) * _STEP, duration) * source.samplerate)
            length = min(end, source.frames) - start
            if length <= 0:
                break
            samples = source.read(length, dtype="float64", always_2d=True)
            levels[index], bands[index], chroma[index], widths[index] = _frame_features(
                samples, source.samplerate
            )
            valid[index] = end <= source.frames
    return _Features(levels, bands, chroma, widths, valid)


def _reference_coverage(
    features: _Features, times: FloatArray, intervals: tuple[tuple[float, float], ...] | None
) -> BoolArray:
    if intervals is None:
        return features.valid.copy()
    covered = np.zeros(len(times), dtype=bool)
    starts = np.floor(times / _STEP) * _STEP
    ends = 2 * times - starts
    for start, end in intervals:
        if not np.isfinite((start, end)).all() or start < 0 or end <= start:
            raise DependencyError(
                "StudioMasterTimelineUnavailable", "Reference coverage is invalid"
            )
        covered |= (starts >= start) & (ends <= end)
    return features.valid & covered


def _activity(features: _Features, valid: BoolArray) -> BoolArray:
    audible = features.levels[valid & (features.levels > -110)]
    if not len(audible):
        return np.zeros(len(valid), dtype=bool)
    threshold = max(-110.0, float(np.percentile(audible, 95)) - 30)
    return valid & (features.levels > threshold)


def _density(features: _Features) -> FloatArray:
    active = _activity(features, features.valid)
    power = features.bands**2
    available = max(2, int(np.count_nonzero(np.max(power, axis=0) > 1e-6)))
    entropy = -np.sum(power * np.log(np.maximum(power, 1e-20)), axis=1) / np.log(available)
    occupied = np.count_nonzero(power > np.max(power, axis=1, keepdims=True) * 0.05, axis=1)
    level = np.zeros(len(active))
    if active.any():
        center = float(np.median(features.levels[active]))
        level = np.clip((features.levels - center + 12) / 24, 0, 1)
    result = 0.55 * entropy + 0.25 * occupied / available + 0.20 * level
    return np.asarray(np.where(active, np.clip(result, 0, 1), 0), dtype=np.float64)


def _contrast(left: FloatArray, right: FloatArray) -> tuple[float, float]:
    before, after = _unit(left.mean(axis=0)), _unit(right.mean(axis=0))
    distance = max(0.0, 1 - float(before @ after))
    variation = float(np.mean(1 - left @ before) + np.mean(1 - right @ after)) / 2
    return distance, max(0.0, variation)


def _structural_score(features: _Features, density: FloatArray, left: slice, right: slice) -> float:
    texture, variation = _contrast(features.bands[left], features.bands[right])
    change = abs(float(np.median(density[left]) - np.median(density[right])))
    texture_score = np.clip((texture - variation) / 0.12, 0, 1) * np.clip(change / 0.15, 0, 1)
    harmony, movement = _contrast(features.chroma[left], features.chroma[right])
    context = np.vstack((features.chroma[left], features.chroma[right])).mean(axis=0) ** 2
    context /= max(float(context.sum()), 1e-20)
    diversity = -float(np.sum(context * np.log(np.maximum(context, 1e-20)))) / np.log(12)
    harmonic_score = np.clip((harmony - 2 * movement) / 0.45, 0, 1)
    harmonic_score *= float(diversity > 0.45 and texture > 0.025)
    return float(max(texture_score, harmonic_score))


def _reference_score(
    features: _Features,
    density: FloatArray,
    voice: BoolArray,
    valid: BoolArray,
    left: slice,
    right: slice,
) -> float:
    first, second = voice[left] & valid[left], voice[right] & valid[right]
    if min(float(first.mean()), float(second.mean())) < 0.6:
        return 0.0
    a, b = features.widths[left][first], features.widths[right][second]
    before, after = float(np.median(a)), float(np.median(b))
    spread = max(float(np.median(abs(a - before))), float(np.median(abs(b - after))))
    stereo = np.clip((abs(before - after) - spread) / 0.18, 0, 1)
    tone, variation = _contrast(features.bands[left][first], features.bands[right][second])
    pitch, _ = _contrast(features.chroma[left][first], features.chroma[right][second])
    change = abs(float(np.median(density[left][first]) - np.median(density[right][second])))
    color = np.clip((tone - variation) / 0.15, 0, 1) * np.clip(change / 0.15, 0, 1)
    return float(max(stereo, color * float(pitch < 0.2)))


def _novelty(
    features: _Features,
    reference: _Features,
    density: FloatArray,
    voice: BoolArray,
    valid: BoolArray,
    duration: float,
) -> FloatArray:
    width = max(2, round(min(4.0, max(0.5, duration / 12)) / _STEP))
    result = np.zeros(len(density))
    reference_density = _density(reference)
    for center in range(width, len(density) - width + 1):
        left, right = slice(center - width, center), slice(center, center + width)
        score = _structural_score(features, density, left, right)
        if np.mean(valid[left]) > 0.9 and np.mean(valid[right]) > 0.9:
            change = abs(float(np.mean(voice[left]) - np.mean(voice[right])))
            score = max(score, float(np.clip((change - 0.35) / 0.55, 0, 1)))
            score = max(
                score, _reference_score(reference, reference_density, voice, valid, left, right)
            )
        result[center] = score
    return result


def _boundaries(novelty: FloatArray, duration: float) -> NDArray[np.int64]:
    minimum = max(2, round(min(6.0, max(0.5, duration / 10)) / _STEP))
    peaks, _ = find_peaks(novelty, height=0.65, prominence=0.15, distance=minimum)
    accepted = peaks[(peaks >= minimum) & (peaks <= len(novelty) - minimum)]
    return np.asarray(np.r_[0, accepted, len(novelty)], dtype=np.int64)


def _anchors(
    features: _Features,
    boundaries: NDArray[np.int64],
    novelty: FloatArray,
    density: FloatArray,
    duration: float,
) -> tuple[BoolArray, list[tuple[float | None, float | None]]]:
    stable = np.zeros(len(density), dtype=bool)
    intervals: list[tuple[float | None, float | None]] = []
    average = gaussian_filter1d(density, sigma=4, mode="nearest")
    variance = gaussian_filter1d(density**2, sigma=4, mode="nearest") - average**2
    steady = np.sqrt(np.maximum(variance, 0)) < 0.045
    local_level = median_filter(features.levels, size=9, mode="nearest")
    steady &= abs(features.levels - local_level) < 3
    for start, end in zip(boundaries[:-1], boundaries[1:]):
        margin = min(6, max(0, int((end - start) * 0.15)))
        eligible = (novelty[start:end] < 0.25) & steady[start:end]
        if margin:
            eligible[:margin], eligible[-margin:] = False, False
        stable[start:end] = eligible
        longest = max(regions(eligible), key=lambda pair: pair[1] - pair[0], default=None)
        if longest is None:
            intervals.append((None, None))
        else:
            begin, finish = longest
            finish = min(finish, begin + round(6 / _STEP))
            intervals.append(((start + begin) * _STEP, min(duration, (start + finish) * _STEP)))
    return stable, intervals


def _part_fingerprint(
    features: _Features, density: FloatArray, start: int, end: int
) -> tuple[FloatArray, FloatArray, float]:
    positions = np.linspace(start, end, 5).astype(int)
    bands, chroma = [], []
    for left, right in zip(positions[:-1], positions[1:]):
        section = slice(left, max(left + 1, right))
        bands.append(_unit(features.bands[section].mean(axis=0)))
        chroma.append(_unit(features.chroma[section].mean(axis=0)))
    return np.asarray(bands), np.asarray(chroma), float(np.median(density[start:end]))


def _similar_parts(
    first: tuple[FloatArray, FloatArray, float], second: tuple[FloatArray, FloatArray, float]
) -> bool:
    bands, chroma, density = first
    other_bands, other_chroma, other_density = second
    texture = float(np.mean(np.sum(bands * other_bands, axis=1)))
    harmony = max(
        float(np.mean(np.sum(chroma * np.roll(other_chroma, shift, axis=1), axis=1)))
        for shift in range(12)
    )
    return texture > 0.96 and harmony > 0.94 and abs(density - other_density) < 0.12


def _same_vocal_production(
    reference: _Features, valid: BoolArray, first: slice, second: slice
) -> bool:
    a, b = valid[first], valid[second]
    if min(float(a.mean()), float(b.mean())) < 0.6:
        return True
    width = abs(
        float(np.median(reference.widths[first][a]) - np.median(reference.widths[second][b]))
    )
    return width < 0.12


def _repeat_groups(
    features: _Features,
    reference: _Features,
    density: FloatArray,
    boundaries: NDArray[np.int64],
    vocal_evidence: BoolArray,
) -> list[int | None]:
    fingerprints = [
        _part_fingerprint(features, density, int(start), int(end))
        for start, end in zip(boundaries[:-1], boundaries[1:])
    ]
    groups: list[int | None] = [None] * len(fingerprints)
    next_group = 0
    for current in range(2, len(fingerprints)):
        length = boundaries[current + 1] - boundaries[current]
        for earlier in range(current - 1):
            other = boundaries[earlier + 1] - boundaries[earlier]
            if min(length, other) / max(length, other) < 0.5:
                continue
            a = slice(boundaries[current], boundaries[current + 1])
            b = slice(boundaries[earlier], boundaries[earlier + 1])
            if not _same_vocal_production(reference, vocal_evidence, a, b):
                continue
            if _similar_parts(fingerprints[current], fingerprints[earlier]):
                if groups[earlier] is None:
                    groups[earlier], next_group = next_group, next_group + 1
                groups[current] = groups[earlier]
                break
    return groups


def _sections(
    features: _Features,
    reference: _Features,
    density: FloatArray,
    novelty: FloatArray,
    vocal_evidence: BoolArray,
    duration: float,
) -> tuple[tuple[ArrangementSection, ...], BoolArray]:
    boundaries = _boundaries(novelty, duration)
    stable, anchors = _anchors(features, boundaries, novelty, density, duration)
    groups = _repeat_groups(features, reference, density, boundaries, vocal_evidence)
    parts = []
    for index, (start, end) in enumerate(zip(boundaries[:-1], boundaries[1:])):
        confidence = float(novelty[start]) if start else 1.0
        parts.append(
            ArrangementSection(
                float(start * _STEP),
                min(duration, float(end * _STEP)),
                confidence,
                groups[index],
                anchors[index][0],
                anchors[index][1],
            )
        )
    return tuple(parts), stable


def analyze_arrangement(
    backing: Path,
    reference_vocal: Path | None,
    cancel: threading.Event,
    *,
    reference_intervals: tuple[tuple[float, float], ...] | None = None,
) -> ArrangementMap:
    _check_cancel(cancel)
    info = sf.info(backing)
    if info.frames <= 0:
        raise DependencyError("StudioMasterInvalidAudio", "Arrangement timeline is empty")
    duration = info.frames / info.samplerate
    count = max(1, int(np.ceil(duration / _STEP)))
    ends = np.minimum((np.arange(count) + 1) * _STEP, duration)
    times = np.asarray((np.arange(count) * _STEP + ends) / 2)
    music = _read_features(backing, count, duration, cancel)
    reference = _read_features(reference_vocal, count, duration, cancel)
    valid = _reference_coverage(reference, times, reference_intervals)
    voice = _activity(reference, valid)
    raw_density = _density(music)
    sigma = min(2.0, max(0.5, count / 40))
    density = gaussian_filter1d(raw_density, sigma=sigma, mode="nearest")
    occupancy = gaussian_filter1d(voice.astype(float), sigma=sigma, mode="nearest")
    priority = np.where(valid, occupancy * (0.55 + 0.45 * density), 0.5)
    novelty = _novelty(music, reference, raw_density, voice, valid, duration)
    sections, stable = _sections(music, reference, density, novelty, voice & valid, duration)
    return ArrangementMap(
        info.frames,
        info.samplerate,
        duration,
        times,
        density,
        priority,
        voice,
        valid,
        stable,
        sections,
    )
