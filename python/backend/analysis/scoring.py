from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Mapping, Sequence

from backend.ai.domain import PitchPoint
from backend.analysis.domain import SectionResult
from backend.lyrics.domain import LyricsDocument, Note


@dataclass(frozen=True, slots=True)
class ScoreSummary:
    pitch_accuracy_percent: float
    mean_semitone_deviation: float
    sections: Sequence[SectionResult]
    problem_regions: Sequence[dict[str, float]]


@dataclass(frozen=True, slots=True)
class PlaybackAdjustment:
    elapsed_seconds: float
    source_seconds: float
    playback_rate: float
    key_shift: float


def score_pitch(
    reference: LyricsDocument,
    actual: Sequence[PitchPoint],
    playback_adjustments: Sequence[Mapping[str, object]] = (),
) -> ScoreSummary:
    adjustments = _valid_adjustments(playback_adjustments)
    samples = [
        _compare_transformed(reference, point, adjustments)
        for point in actual
        if point.confidence >= 0.3
    ]
    compared = [(time, deviation) for time, deviation in samples if deviation is not None]
    if not compared:
        return ScoreSummary(0.0, 0.0, (), ())
    deviations = [deviation for _, deviation in compared]
    accuracy = 100.0 * sum(1 for value in deviations if value <= 0.5) / len(deviations)
    mean = sum(deviations) / len(deviations)
    sections = _sections(compared, reference.duration)
    problems = tuple(
        {"start": time, "end": time + 0.05, "deviation": value}
        for time, value in compared
        if value > 1.0
    )
    return ScoreSummary(accuracy, mean, sections, problems)


def _compare_transformed(
    reference: LyricsDocument,
    point: PitchPoint,
    adjustments: Sequence[PlaybackAdjustment],
) -> tuple[float, float | None]:
    adjustment = _adjustment_at(adjustments, point.time)
    if adjustment is None:
        source_time = point.time
        key_shift = 0.0
    else:
        source_time = adjustment.source_seconds + (
            point.time - adjustment.elapsed_seconds
        ) * adjustment.playback_rate
        key_shift = adjustment.key_shift
    return _compare(point, _note_at(reference, source_time), source_time, key_shift)


def _valid_adjustments(
    raw: Sequence[Mapping[str, object]],
) -> tuple[PlaybackAdjustment, ...]:
    result: list[PlaybackAdjustment] = []
    for item in raw:
        try:
            elapsed = _number(item["elapsedSeconds"])
            source = _number(item["sourceSeconds"])
            rate = _number(item["playbackRate"])
            shift = _number(item["keyShift"])
        except (KeyError, TypeError):
            continue
        if not all(math.isfinite(value) for value in (elapsed, source, rate, shift)):
            continue
        if elapsed < 0 or source < 0 or not 0.5 <= rate <= 1.5 or not -12 <= shift <= 12:
            continue
        result.append(PlaybackAdjustment(elapsed, source, rate, shift))
    return tuple(sorted(result, key=lambda item: item.elapsed_seconds))


def _number(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError("Playback adjustment values must be numbers")
    return float(value)


def _adjustment_at(
    adjustments: Sequence[PlaybackAdjustment], elapsed_seconds: float
) -> PlaybackAdjustment | None:
    current: PlaybackAdjustment | None = None
    for adjustment in adjustments:
        if adjustment.elapsed_seconds > elapsed_seconds:
            break
        current = adjustment
    return current


def _note_at(document: LyricsDocument, time: float) -> Note | None:
    for word in document.words:
        if word.start <= time <= word.end:
            for note in word.notes:
                if note.start <= time <= note.end:
                    return note
    return None


def _compare(
    point: PitchPoint,
    note: Note | None,
    source_time: float,
    key_shift: float,
) -> tuple[float, float | None]:
    if note is None or point.frequency <= 0:
        return source_time, None
    expected = 440.0 * (2.0 ** ((note.note + key_shift - 69) / 12.0))
    deviation = abs(12.0 * math.log2(point.frequency / expected))
    return source_time, deviation


def _sections(samples: Sequence[tuple[float, float]], duration: float) -> tuple[SectionResult, ...]:
    result: list[SectionResult] = []
    step = 10.0
    start = 0.0
    while start < duration:
        end = min(duration, start + step)
        values = [value for time, value in samples if start <= time < end]
        if values:
            result.append(
                SectionResult(
                    start,
                    end,
                    100.0 * sum(1 for value in values if value <= 0.5) / len(values),
                    sum(values) / len(values),
                )
            )
        start = end
    return tuple(result)
