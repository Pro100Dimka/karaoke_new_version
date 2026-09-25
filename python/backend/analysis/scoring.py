from __future__ import annotations

import math
import statistics
from dataclasses import dataclass
from typing import Mapping, Sequence

from backend.ai.domain import PitchPoint
from backend.analysis.domain import SectionResult
from backend.lyrics.domain import LyricsDocument, Note


KARAOKE_PITCH_TOLERANCE_SEMITONES = 1.0
GREEN_NOTE_COVERAGE = 0.5


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
    performance_duration: float | None = None,
    note_score: Mapping[str, object] | None = None,
) -> ScoreSummary:
    adjustments = _valid_adjustments(playback_adjustments)
    samples = [
        _compare_transformed(reference, point, adjustments)
        for point in actual
        if point.confidence >= 0.3
    ]
    compared = [(time, deviation) for time, deviation in samples if deviation is not None]
    saved_note_percentage = _saved_note_percentage(note_score)
    if not compared:
        return ScoreSummary(saved_note_percentage or 0.0, 0.0, (), ())
    deviations = [deviation for _, deviation in compared]
    accuracy = saved_note_percentage if saved_note_percentage is not None else (
        _green_note_percentage(reference, actual, adjustments, performance_duration)
        if performance_duration is not None
        else 100.0 * sum(
            1 for value in deviations if value <= KARAOKE_PITCH_TOLERANCE_SEMITONES
        ) / len(deviations)
    )
    mean = sum(deviations) / len(deviations)
    sections = _sections(compared, reference.duration)
    problems = tuple(
        {"start": time, "end": time + 0.05, "deviation": value}
        for time, value in compared
        if value > 1.0
    )
    return ScoreSummary(accuracy, mean, sections, problems)


def _saved_note_percentage(note_score: Mapping[str, object] | None) -> float | None:
    if note_score is None:
        return None
    hit = note_score.get("hitNotes")
    total = note_score.get("totalNotes")
    if (isinstance(hit, bool) or not isinstance(hit, int) or isinstance(total, bool) or
            not isinstance(total, int) or hit < 0 or total <= 0 or hit > total):
        return None
    return 100.0 * hit / total


def _green_note_percentage(
    reference: LyricsDocument,
    actual: Sequence[PitchPoint],
    adjustments: Sequence[PlaybackAdjustment],
    performance_duration: float,
) -> float:
    duration = max(0.0, performance_duration)
    intervals = _played_source_intervals(adjustments, duration)
    notes = {
        (word_index, note_index): note
        for word_index, word in enumerate(reference.words)
        for note_index, note in enumerate(word.notes)
        if any(note.start < end and note.end > start for start, end in intervals)
    }
    if not notes:
        return 0.0

    sample_seconds = _pitch_sample_seconds(actual)
    matched: dict[tuple[int, int], float] = {}
    for point in actual:
        if point.confidence < 0.3 or point.time > duration:
            continue
        adjustment = _adjustment_at(adjustments, point.time)
        rate = adjustment.playback_rate if adjustment is not None else 1.0
        source_time = point.time if adjustment is None else (
            adjustment.source_seconds + (point.time - adjustment.elapsed_seconds) * rate)
        located = _indexed_note_at(reference, source_time)
        if located is None:
            continue
        key, note = located
        _, deviation = _compare(point, note, source_time, adjustment.key_shift if adjustment else 0.0)
        if deviation is not None and deviation <= KARAOKE_PITCH_TOLERANCE_SEMITONES:
            matched[key] = matched.get(key, 0.0) + sample_seconds * rate

    green = sum(
        1 for key, note in notes.items()
        if matched.get(key, 0.0) + 1e-9 >= (note.end - note.start) * GREEN_NOTE_COVERAGE
    )
    return 100.0 * green / len(notes)


def _pitch_sample_seconds(actual: Sequence[PitchPoint]) -> float:
    times = sorted(point.time for point in actual if point.confidence >= 0.3)
    steps = [
        later - earlier for earlier, later in zip(times, times[1:], strict=False)
        if 0 < later - earlier <= 0.2
    ]
    return statistics.median(steps) if steps else 0.05


def _played_source_intervals(
    adjustments: Sequence[PlaybackAdjustment], duration: float
) -> tuple[tuple[float, float], ...]:
    if not adjustments:
        return ((0.0, duration),)
    result: list[tuple[float, float]] = []
    for index, adjustment in enumerate(adjustments):
        end_elapsed = adjustments[index + 1].elapsed_seconds if index + 1 < len(adjustments) else duration
        end_elapsed = min(duration, end_elapsed)
        if end_elapsed <= adjustment.elapsed_seconds:
            continue
        source_end = adjustment.source_seconds + (end_elapsed - adjustment.elapsed_seconds) * adjustment.playback_rate
        result.append(tuple(sorted((adjustment.source_seconds, source_end))))
    return tuple(result)


def _indexed_note_at(
    document: LyricsDocument, time: float
) -> tuple[tuple[int, int], Note] | None:
    for word_index, word in enumerate(document.words):
        if word.start <= time <= word.end:
            for note_index, note in enumerate(word.notes):
                if note.start <= time <= note.end:
                    return (word_index, note_index), note
    return None


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
                    100.0 * sum(
                        1 for value in values
                        if value <= KARAOKE_PITCH_TOLERANCE_SEMITONES
                    ) / len(values),
                    sum(values) / len(values),
                )
            )
        start = end
    return tuple(result)
