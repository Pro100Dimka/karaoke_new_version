"""Conservative octave-family evidence anchored to an already known lead melody."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
import math
import threading

import numpy as np
from numpy.typing import NDArray
import soundfile as sf
from scipy.signal import find_peaks, resample_poly

from backend.ai.domain import PitchPoint
from backend.domain_errors import DependencyError
from backend.recordings.studio_audio import _check_cancel
from backend.recordings.studio_layer_types import VocalLayerRegion

_RATE = 16000
_STEP = 0.05
_FFT = 16384
_LONG_RADIUS = round(_RATE * 0.064)
_SHORT_RADIUS = round(_RATE * 0.032)


@dataclass(frozen=True, slots=True)
class _Peaks:
    frequency: NDArray[np.float64]
    amplitude: NDArray[np.float64]
    pan: NDArray[np.float64]
    maximum: float


@dataclass(frozen=True, slots=True)
class _Family:
    frequency: float
    power: float
    pan: float
    scatter: float


def _spectrum(samples: NDArray[np.float64]) -> _Peaks:
    transformed = np.fft.rfft(samples * np.hanning(len(samples))[:, None], n=_FFT, axis=0)
    amplitude = np.sqrt(np.mean(abs(transformed) ** 2, axis=1))
    maximum = float(np.max(amplitude, initial=0))
    indexes = find_peaks(amplitude, prominence=maximum * 0.01, distance=6)[0]
    indexes = indexes[(indexes * _RATE / _FFT >= 50) & (indexes * _RATE / _FFT <= 7000)]
    logarithm = np.log(np.maximum(amplitude, 1e-30))
    denominator = logarithm[indexes - 1] - 2 * logarithm[indexes] + logarithm[indexes + 1]
    offset = (
        0.5 * (logarithm[indexes - 1] - logarithm[indexes + 1]) / np.minimum(denominator, -1e-20)
    )
    frequency = (indexes + np.clip(offset, -0.5, 0.5)) * _RATE / _FFT
    channels = abs(transformed[indexes])
    pan = 20 * np.log10(np.maximum(channels[:, 0], 1e-20) / np.maximum(channels[:, -1], 1e-20))
    return _Peaks(frequency, amplitude[indexes], pan, maximum)


def _family(
    peaks: _Peaks, base: float, harmonics: Sequence[int], *, continuation: bool = False
) -> _Family | None:
    rows = []
    for harmonic in harmonics:
        selected = np.flatnonzero(abs(1200 * np.log2(peaks.frequency / (base * harmonic))) < 60)
        if not len(selected):
            continue
        index = selected[np.argmax(peaks.amplitude[selected])]
        if peaks.amplitude[index] >= peaks.maximum * 0.02:
            rows.append(
                (
                    peaks.frequency[index] / harmonic,
                    peaks.amplitude[index],
                    peaks.pan[index],
                    harmonic,
                )
            )
    minimum = 2 if continuation else 3
    if len(rows) < minimum:
        return None
    values = np.asarray(rows)
    center = float(np.median(values[:, 0]))
    values = values[abs(1200 * np.log2(values[:, 0] / center)) <= 25]
    if len(values) < minimum or (continuation and not np.any(values[:, 3] == 1)):
        return None
    center = float(np.median(values[:, 0]))
    scatter = float(np.median(abs(1200 * np.log2(values[:, 0] / center))))
    if scatter > 12:
        return None
    return _Family(
        center, float(np.sum(values[:, 1] ** 2)), float(np.median(values[:, 2])), scatter
    )


def _pair(
    peaks: _Peaks, lead: float, semitones: int, *, continuation: bool = False
) -> tuple[float, float, float] | None:
    ratio = 2 ** (semitones / 12)
    main = _family(peaks, lead, (1, 2, 3, 4, 5) if semitones < 0 else (1, 3, 5, 7, 9))
    other = _family(
        peaks,
        lead * ratio,
        (1, 3, 5, 7, 9) if semitones < 0 else (1, 2, 3, 4, 5),
        continuation=continuation,
    )
    if main is None or other is None:
        return None
    difference = 1200 * math.log2(other.frequency / main.frequency / ratio)
    if abs(difference) > 60:
        return None
    if semitones > 0 and _unison_family(peaks, main, other):
        return None
    gain = float(np.clip(math.sqrt(other.power / max(main.power, 1e-20)), 0.0, 0.35))
    return difference, other.pan - main.pan, gain


def _unison_family(peaks: _Peaks, main: _Family, upper: _Family) -> bool:
    """The upper candidate's intervening odd partials instead identify a unison."""
    matched = 0
    for harmonic in (1, 3, 5, 7, 9, 11, 13, 15):
        target = upper.frequency * harmonic / 2
        near = abs(1200 * np.log2(peaks.frequency / target)) <= 5
        near &= peaks.amplitude >= peaks.maximum * 0.02
        if abs(1200 * math.log2(upper.frequency / 2 / main.frequency)) < 10:
            # When frequencies coincide, only a separate spatial family can
            # identify which voice owns the intervening odd partials.
            near &= abs(peaks.pan - upper.pan) <= 2
        matched += int(np.any(near))
    return matched >= 3


def _evidence(
    long: _Peaks, short: _Peaks, lead: float, semitones: int, *, continuation: bool = False
) -> float:
    first = _pair(long, lead, semitones, continuation=continuation)
    second = _pair(short, lead, semitones, continuation=continuation)
    if first is None or second is None or abs(first[0] - second[0]) > 15:
        return 0.0
    # Static stereo coloration can give odd/even harmonics different panning.
    # Independent frequency evidence at BOTH resolutions is still necessary.
    detuned = abs(first[0]) >= 5 and abs(second[0]) >= 5 and first[0] * second[0] > 0
    return min(first[2], second[2]) if detuned else 0.0


def _guide(
    points: Sequence[PitchPoint], times: NDArray[np.float64]
) -> tuple[NDArray[np.float64], NDArray[np.float64], NDArray[np.float64]]:
    valid = [
        point
        for point in points
        if math.isfinite(point.time)
        and math.isfinite(point.frequency)
        and math.isfinite(point.confidence)
        and point.audio_active is not False
    ]
    valid.sort(key=lambda point: point.time)
    if not valid:
        return np.zeros(len(times)), np.zeros(len(times)), np.empty((0, 2))
    rows = np.array([(point.time, point.frequency, point.confidence) for point in valid])
    right = np.clip(np.searchsorted(rows[:, 0], times), 0, len(rows) - 1)
    left = np.maximum(0, right - 1)
    indexes = np.where(abs(rows[left, 0] - times) < abs(rows[right, 0] - times), left, right)
    trusted = (abs(rows[indexes, 0] - times) <= 0.025) & (rows[indexes, 2] >= 0.65)
    trusted &= (rows[indexes, 1] >= 50) & (rows[indexes, 1] <= 1200)
    history = rows[(rows[:, 2] >= 0.65) & (rows[:, 1] >= 50) & (rows[:, 1] <= 1200), :2]
    return np.where(trusted, rows[indexes, 1], 0), np.where(trusted, rows[indexes, 2], 0), history


def _recent_note(history: NDArray[np.float64], time: float, frequency: float) -> bool:
    start, end = np.searchsorted(history[:, 0], [time - 1.0, time - 0.075])
    previous = history[start:end, 1]
    # An earlier lead note lingering after an octave jump is reverb/delay evidence,
    # not proof of a simultaneously sung new register.
    return bool(np.any(abs(1200 * np.log2(previous / frequency)) < 45))


def _read_batch(
    audio: sf.SoundFile, times: NDArray[np.float64]
) -> tuple[NDArray[np.float64], float]:
    start = max(0, math.floor((times[0] - 0.128) * audio.samplerate))
    end = min(audio.frames, math.ceil((times[-1] + 0.128) * audio.samplerate))
    audio.seek(start)
    samples = audio.read(end - start, always_2d=True)
    if not np.isfinite(samples).all():
        raise DependencyError("StudioMasterInvalidAudio", "Audio contains invalid samples")
    divisor = math.gcd(audio.samplerate, _RATE)
    resampled = resample_poly(samples, _RATE // divisor, audio.samplerate // divisor, axis=0)
    return np.asarray(resampled, dtype=np.float64), start / audio.samplerate


def _measure(
    reference: Path,
    times: NDArray[np.float64],
    lead: NDArray[np.float64],
    history: NDArray[np.float64],
    cancel: threading.Event,
) -> tuple[NDArray[np.float64], NDArray[np.bool_]]:
    gains = np.zeros((len(times), 2))
    anchors = np.zeros_like(gains, dtype=bool)
    with sf.SoundFile(reference) as audio:
        for first in range(0, len(times), 40):
            _check_cancel(cancel)
            batch = times[first : first + 40]
            if not np.any(lead[first : first + len(batch)]):
                continue
            samples, origin = _read_batch(audio, batch)
            for offset, time in enumerate(batch):
                index = first + offset
                if not lead[index]:
                    continue
                center = round((time - origin) * _RATE)
                long = _spectrum(samples[center - _LONG_RADIUS : center + _LONG_RADIUS])
                short = _spectrum(samples[center - _SHORT_RADIUS : center + _SHORT_RADIUS])
                gains[index], anchors[index] = _frame_evidence(
                    long, short, float(lead[index]), history, float(time)
                )
    return gains, anchors


def _frame_evidence(
    long: _Peaks, short: _Peaks, lead: float, history: NDArray[np.float64], time: float
) -> tuple[NDArray[np.float64], NDArray[np.bool_]]:
    gains, anchors = np.zeros(2), np.zeros(2, dtype=bool)
    for column, semitones in enumerate((-12, 12)):
        if _recent_note(history, time, lead * 2 ** (semitones / 12)):
            continue
        gains[column] = _evidence(long, short, lead, semitones)
        anchors[column] = gains[column] >= 0.06
        if semitones < 0:
            gains[column] = max(gains[column], _evidence(long, short, lead, -12, continuation=True))
    return gains, anchors


def _regions(
    times: NDArray[np.float64],
    gains: NDArray[np.float64],
    confidence: NDArray[np.float64],
    duration: float,
    history: NDArray[np.float64],
    anchors: NDArray[np.bool_],
) -> list[VocalLayerRegion]:
    regions = []
    for column, semitones in enumerate((-12, 12)):
        for left, right in _trusted_intervals(history, duration):
            supported = np.flatnonzero(
                (gains[:, column] >= 0.06) & (times >= left) & (times <= right)
            )
            groups = np.split(supported, np.flatnonzero(np.diff(supported) > 5) + 1)
            for group in groups:
                if len(group) < 3 or np.count_nonzero(anchors[group, column]) < 3:
                    continue
                if times[group[-1]] - times[group[0]] < 0.099:
                    continue
                regions.append(
                    VocalLayerRegion(
                        max(float(left), float(times[group[0]]) - 0.075),
                        min(float(right), float(times[group[-1]]) + 0.075),
                        "octave",
                        float(np.median(gains[group, column])),
                        semitones=semitones,
                        confidence=float(np.mean(confidence[group])),
                    )
                )
    return sorted(regions, key=lambda region: region.start)


def _trusted_intervals(history: NDArray[np.float64], duration: float) -> NDArray[np.float64]:
    points = history[:, 0]
    groups = np.split(points, np.flatnonzero(np.diff(points) > 0.05) + 1)
    return np.array(
        [
            (max(0, group[0] - 0.025), min(duration, group[-1] + 0.025))
            for group in groups
            if len(group)
        ]
    )


def analyze_octaves(
    reference: Path,
    cancel: threading.Event,
    *,
    reference_pitch: Sequence[PitchPoint] = (),
) -> tuple[list[VocalLayerRegion], dict[str, object]]:
    """Use a reused lead guide in this exact PCM timeline; never infer it from overtones."""
    _check_cancel(cancel)
    report: dict[str, object] = {
        "method": "independent-octave-partial-families",
        "supportedFrames": 0,
        "guideSource": "reused-reference-pitch",
    }
    info = sf.info(reference)
    if (
        not reference_pitch
        or info.duration < 0.5
        or info.channels not in (1, 2)
        or info.samplerate < 8000
    ):
        return [], {**report, "reason": "missing-guide-or-unsupported-audio"}
    times = np.arange(0.128, info.duration - 0.128, _STEP)
    lead, confidence, history = _guide(reference_pitch, times)
    if not np.any(lead):
        return [], {**report, "reason": "no-confident-reference-guide"}
    gains, anchors = _measure(reference, times, lead, history, cancel)
    _check_cancel(cancel)
    regions = _regions(times, gains, confidence, info.duration, history, anchors)
    report.update(
        supportedFrames=int(np.count_nonzero(gains)),
        anchorFrames=int(np.count_nonzero(anchors)),
        analyzedFrames=int(np.count_nonzero(lead)),
        regionCount=len(regions),
        analysisRate=_RATE,
        windowMs=[64, 128],
        confidenceMeasure="reference-pitch-confidence",
        minimumIndependentPartials=3,
    )
    return regions, report
