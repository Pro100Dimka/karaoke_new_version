from __future__ import annotations
from pathlib import Path
from collections.abc import Mapping, Sequence
import math
import threading
import numpy as np
from numpy.typing import NDArray
from scipy.signal import correlate, resample_poly
import soundfile as sf

from backend.recordings.studio_audio import _check_cancel
from backend.analysis.scoring import parse_playback_adjustments


def reference_section(
    adjustments: Sequence[Mapping[str, object]],
    duration: float,
) -> tuple[float, float] | None:
    parsed = parse_playback_adjustments(adjustments)
    if not parsed or len(parsed) != len(adjustments) or parsed[0].elapsed_seconds != 0:
        return None
    previous = parsed[0]
    for current in parsed[1:]:
        expected = (
            previous.source_seconds
            + (current.elapsed_seconds - previous.elapsed_seconds) * previous.playback_rate
        )
        if current.elapsed_seconds > duration or abs(current.source_seconds - expected) > 0.05:
            return None
        previous = current
    start = parsed[0].source_seconds
    end = previous.source_seconds + (duration - previous.elapsed_seconds) * previous.playback_rate
    return (start, end) if 0 <= start < end else None


def copy_reference_section(
    source: Path, target: Path, section: tuple[float, float], cancel: threading.Event
) -> None:
    with (
        sf.SoundFile(source) as original,
        sf.SoundFile(
            target,
            "w",
            samplerate=original.samplerate,
            channels=original.channels,
            subtype="FLOAT",
        ) as output,
    ):
        original.seek(min(original.frames, round(section[0] * original.samplerate)))
        remaining = min(original.frames, round(section[1] * original.samplerate)) - original.tell()
        while remaining > 0:
            _check_cancel(cancel)
            block = original.read(min(65536, remaining), dtype="float32", always_2d=True)
            output.write(block)
            remaining -= len(block)


def _reference_offset(
    backing: Path,
    original: Path,
    origin: float | None,
    cancel: threading.Event,
) -> tuple[float, float]:
    # Match the SAME accompaniment, never two different singers. Tempo/key/seek changes
    # disable PCM matching; their explicit timeline mapping remains authoritative.
    if origin is None:
        return 0.0, 0.0
    duration = sf.info(backing).duration
    if duration < 8:
        return 0.0, 0.0
    rate = 4000
    margin = 0.25
    offsets, scores = [], []

    with sf.SoundFile(backing) as take, sf.SoundFile(original) as reference:
        for position in np.linspace(1, duration - 3, 3):
            _check_cancel(cancel)
            start = origin + position - margin
            if start < 0 or start + 2 + 2 * margin > reference.frames / reference.samplerate:
                continue
            actual = _read_reference(take, float(position), 2, rate)
            expected = _read_reference(reference, float(start), 2 + 2 * margin, rate)
            match = _reference_match(actual, expected)
            if match is None:
                continue
            peak, score = match
            offsets.append(peak / rate - margin)
            scores.append(score)
    if len(offsets) < 3 or np.ptp(offsets) > 0.002:
        return 0.0, 0.0
    return float(np.median(offsets)), min(scores)


def _read_reference(
    source: sf.SoundFile, start: float, seconds: float, rate: int
) -> NDArray[np.float64]:
    source.seek(round(start * source.samplerate))
    samples = source.read(round(seconds * source.samplerate), always_2d=True).mean(axis=1)
    divisor = math.gcd(source.samplerate, rate)
    return np.asarray(
        resample_poly(samples, rate // divisor, source.samplerate // divisor),
        dtype=np.float64,
    )


def _reference_match(actual: np.ndarray, expected: np.ndarray) -> tuple[int, float] | None:
    actual -= actual.mean()
    power = float(actual @ actual)
    if power < 1e-8 or len(expected) < len(actual):
        return None
    count = len(actual)
    sums = np.r_[0.0, np.cumsum(expected)]
    squares = np.r_[0.0, np.cumsum(expected * expected)]
    variance = squares[count:] - squares[:-count] - (sums[count:] - sums[:-count]) ** 2 / count
    similarity = correlate(expected, actual, mode="valid", method="fft") / np.sqrt(
        np.maximum(variance * power, 1e-20)
    )
    peak = int(np.argmax(similarity))
    score = float(similarity[peak])
    if score < 0.9 or peak in (0, len(similarity) - 1):
        return None
    competing = similarity.copy()
    competing[max(0, peak - 200) : peak + 201] = -1
    if score - float(np.max(competing)) < 0.05:
        return None
    return peak, score


def mapped_reference_times(
    times: NDArray[np.floating],
    adjustments: Sequence[Mapping[str, object]],
    offset_result: tuple[float, float] | None,
    origin: float,
) -> tuple[NDArray[np.floating], bool, dict[str, object]]:
    report: dict[str, object] = {}
    source_times = times.copy()
    parsed = parse_playback_adjustments(adjustments)
    for adjustment in parsed:
        selected = times >= adjustment.elapsed_seconds
        source_times[selected] = (
            adjustment.source_seconds
            + (times[selected] - adjustment.elapsed_seconds) * adjustment.playback_rate
        )
    timing_known = (
        bool(parsed) and parsed[0].elapsed_seconds == 0 and len(parsed) == len(adjustments)
    )
    source_times -= origin
    if offset_result is not None:
        correction, confidence = offset_result
        if confidence >= 0.9:
            source_times += correction
        timing_known = timing_known or (not adjustments and confidence >= 0.9)
        report.update(
            referenceOffsetMs=correction * 1000,
            referenceCorrelation=confidence,
            synchronization=(
                "backing-reference-confirmed" if confidence >= 0.9 else "native-timeline-retained"
            ),
        )

    return source_times, timing_known, report


def scope_reference(
    reference: Path,
    original: Path,
    adjustments: Sequence[Mapping[str, object]],
    duration: float,
    work: Path,
    cancel: threading.Event,
) -> tuple[Path, Path, float, dict[str, object]]:
    section = reference_section(adjustments, duration)
    if section is None:
        return _scope_discontinuous(reference, original, adjustments, duration, work, cancel)
    if section[0] >= min(sf.info(reference).duration, sf.info(original).duration):
        return reference, original, 0.0, {"referenceScope": "outside-reference"}
    targets = work / "reference-section.wav", work / "instrumental-section.wav"
    for source, target in zip((reference, original), targets):
        copy_reference_section(source, target, section, cancel)
    return (
        *targets,
        section[0],
        {
            "referenceScope": "continuous-performed-section",
            "referenceSectionSeconds": list(section),
        },
    )


def _scope_discontinuous(
    reference: Path,
    original: Path,
    adjustments: Sequence[Mapping[str, object]],
    duration: float,
    work: Path,
    cancel: threading.Event,
) -> tuple[Path, Path, float, dict[str, object]]:
    parsed = parse_playback_adjustments(adjustments)
    if (
        not parsed
        or len(parsed) != len(adjustments)
        or parsed[0].elapsed_seconds != 0
        or any(a.playback_rate != 1 or a.elapsed_seconds >= duration for a in parsed)
    ):
        return reference, original, 0.0, {"referenceScope": "unconfirmed-timeline"}
    ends = [a.elapsed_seconds for a in parsed[1:]] + [duration]
    segments = [(a.source_seconds, end - a.elapsed_seconds) for a, end in zip(parsed, ends)]
    available = min(sf.info(reference).duration, sf.info(original).duration)
    if any(start < 0 or length <= 0 or start + length > available for start, length in segments):
        return reference, original, 0.0, {"referenceScope": "outside-reference"}
    targets = work / "reference-section.wav", work / "instrumental-section.wav"
    for source, target in zip((reference, original), targets):
        _copy_segments(source, target, segments, cancel)
    return (
        *targets,
        0.0,
        {
            "referenceScope": "performed-seek-sections",
            "referenceTimelineRebuilt": True,
            "referenceSegmentsSeconds": segments,
        },
    )


def _copy_segments(
    source: Path, target: Path, segments: list[tuple[float, float]], cancel: threading.Event
) -> None:
    with (
        sf.SoundFile(source) as original,
        sf.SoundFile(
            target, "w", samplerate=original.samplerate, channels=original.channels, subtype="FLOAT"
        ) as output,
    ):
        elapsed = 0.0
        for start, length in segments:
            original.seek(round(start * original.samplerate))
            elapsed += length
            remaining = round(elapsed * original.samplerate) - output.tell()
            while remaining > 0:
                _check_cancel(cancel)
                block = original.read(min(65536, remaining), dtype="float32", always_2d=True)
                if not len(block):
                    raise ValueError("Reference segment ended before the performed interval")
                output.write(block)
                remaining -= len(block)
