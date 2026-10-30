from __future__ import annotations

import math
import statistics
from bisect import bisect_left
from dataclasses import dataclass
from itertools import pairwise
from typing import Mapping, Sequence

from backend.ai.domain import PitchPoint
from backend.analysis.domain import SectionResult
from backend.domain_errors import DomainError
from backend.lyrics.domain import LyricsDocument, Note


KARAOKE_PITCH_TOLERANCE_SEMITONES = 1.0
GREEN_NOTE_COVERAGE = 0.5


@dataclass(frozen=True, slots=True)
class ScoreSummary:
    pitch_accuracy_percent: float
    mean_semitone_deviation: float
    rhythm_accuracy_percent: float
    note_stability_percent: float
    sections: Sequence[SectionResult]
    problem_regions: Sequence[dict[str, float]]


@dataclass(frozen=True, slots=True)
class PlaybackAdjustment:
    elapsed_seconds: float
    source_seconds: float
    playback_rate: float
    key_shift: float


def reference_audio_start(raw: Sequence[Mapping[str, object]]) -> float | None:
    """PCM correlation is meaningful only while tempo, key and source position stay continuous."""
    adjustments = parse_playback_adjustments(raw)
    if len(adjustments) != len(raw) or len(adjustments) > 1:
        return None
    if not adjustments:
        return 0.0
    initial = adjustments[0]
    unmodified = (
        initial.elapsed_seconds == 0 and initial.playback_rate == 1 and initial.key_shift == 0
    )
    return initial.source_seconds if unmodified else None


def score_pitch(
    reference: LyricsDocument,
    actual: Sequence[PitchPoint],
    playback_adjustments: Sequence[Mapping[str, object]] = (),
    performance_duration: float | None = None,
    note_score: Mapping[str, object] | None = None,
    *,
    reference_pitch: Sequence[PitchPoint] | None = None,
) -> ScoreSummary:
    adjustments = parse_playback_adjustments(playback_adjustments)
    if reference_pitch is not None:
        notes = sorted(
            (note for word in reference.words for note in word.notes), key=lambda note: note.start
        )
        if notes:
            reference_pitch = tuple(
                PitchPoint(
                    time,
                    440 * 2 ** ((pitch - 69) / 12) if pitch is not None else 0.0,
                    1.0 if pitch is not None else 0.0,
                    active,
                )
                for time, pitch, active in reference.target_frames()
            )
        return _score_contours(
            reference,
            actual,
            reference_pitch,
            adjustments,
            performance_duration if performance_duration is not None else reference.duration,
        )
    return _score_notes(reference, actual, adjustments, performance_duration, note_score)


def _score_notes(
    reference: LyricsDocument,
    actual: Sequence[PitchPoint],
    adjustments: Sequence[PlaybackAdjustment],
    performance_duration: float | None,
    note_score: Mapping[str, object] | None,
) -> ScoreSummary:
    samples = [
        _compare_transformed(reference, point, adjustments)
        for point in actual
        if point.confidence >= 0.3
    ]
    compared = [(time, deviation) for time, deviation in samples if deviation is not None]
    rhythm, stability = _performance_metrics(
        reference, actual, adjustments, performance_duration, note_score
    )
    saved_note_percentage = _saved_note_percentage(note_score)
    if not compared:
        return ScoreSummary(saved_note_percentage or 0.0, 0.0, rhythm, stability, (), ())
    deviations = [deviation for _, deviation in compared]
    if saved_note_percentage is not None:
        accuracy = saved_note_percentage
    elif performance_duration is not None:
        accuracy = _green_note_percentage(reference, actual, adjustments, performance_duration)
    else:
        accuracy = (
            100.0
            * sum(value <= KARAOKE_PITCH_TOLERANCE_SEMITONES for value in deviations)
            / len(deviations)
        )
    mean = sum(deviations) / len(deviations)
    sections = _sections(compared, reference.duration)
    problems = tuple(
        {"start": time, "end": time + 0.05, "deviation": value}
        for time, value in compared
        if value > 1.0
    )
    return ScoreSummary(accuracy, mean, rhythm, stability, sections, problems)


def _score_contours(
    document: LyricsDocument,
    actual: Sequence[PitchPoint],
    reference: Sequence[PitchPoint],
    adjustments: Sequence[PlaybackAdjustment],
    duration: float,
) -> ScoreSummary:
    """Compare voiced audio frames, retaining the original singer's vibrato and rests."""
    frames = _contour_frames(actual, reference, adjustments, duration)
    assessed = [
        time
        for time, _, sung, error, required in frames
        if error is not None or (required and not sung)
    ]
    if len(assessed) < sum(required for _, _, _, _, required in frames) * 0.25:
        raise DomainError(
            "AnalysisPitchUncertain", "Recording has too little reliable pitch evidence", 422
        )
    union = sum(target or sung for _, target, sung, _, _ in frames)
    intersection = sum(target and sung for _, target, sung, _, _ in frames)
    signed = [error for _, _, _, error, _ in frames if error is not None]
    compared = [(time, abs(error)) for time, _, _, error, _ in frames if error is not None]
    hits = sum(abs(error) <= KARAOKE_PITCH_TOLERANCE_SEMITONES for error in signed)
    center = statistics.mean(signed) if signed else 0.0
    steady = sum(abs(error - center) <= KARAOKE_PITCH_TOLERANCE_SEMITONES / 2 for error in signed)
    step = _pitch_sample_seconds(actual)
    problems = tuple(
        {"start": time, "end": time + step, "deviation": deviation}
        for time, deviation in compared
        if deviation > KARAOKE_PITCH_TOLERANCE_SEMITONES
    )
    return ScoreSummary(
        100.0 * hits / len(assessed) if assessed else 0.0,
        statistics.mean(value for _, value in compared) if compared else 0.0,
        100.0 * intersection / union if union else 0.0,
        100.0 * steady / len(signed) if signed else 0.0,
        _sections(compared, document.duration, assessed),
        problems,
    )


def _contour_frames(
    actual: Sequence[PitchPoint],
    reference: Sequence[PitchPoint],
    adjustments: Sequence[PlaybackAdjustment],
    duration: float,
) -> list[tuple[float, bool, bool, float | None, bool]]:
    actual = sorted(actual, key=lambda point: point.time)
    reference = sorted(reference, key=lambda point: point.time)
    actual_times, reference_times = [p.time for p in actual], [p.time for p in reference]
    actual_step, reference_step = _pitch_sample_seconds(actual), _pitch_sample_seconds(reference)
    step = min(actual_step, reference_step)
    frames = []
    for index in range(math.ceil(max(0.0, duration) / step)):
        elapsed = index * step
        adjustment = _adjustment_at(adjustments, elapsed)
        source = _source_time(elapsed, adjustment)
        target, target_active = _pitch_at(reference, reference_times, source, reference_step)
        sung, sung_active = _pitch_at(actual, actual_times, elapsed, actual_step)
        error = None
        if target is not None and sung is not None:
            error = 12 * math.log2(sung / target) - (adjustment.key_shift if adjustment else 0)
            # Live karaoke accepts the singer's register while comparing the same note names.
            error -= 12 * round(error / 12)
        frames.append((source, target_active, sung_active, error, target is not None))
    return frames


def _pitch_at(
    points: Sequence[PitchPoint],
    times: Sequence[float],
    time: float,
    step: float,
) -> tuple[float | None, bool]:
    index = bisect_left(times, time)
    candidates = [candidate for candidate in (index - 1, index) if 0 <= candidate < len(points)]
    if not candidates:
        return None, False
    point = points[min(candidates, key=lambda candidate: abs(times[candidate] - time))]
    if abs(point.time - time) > step * 0.51:
        return None, False
    pitched = point.confidence >= 0.3 and point.frequency > 0
    active = point.audio_active if point.audio_active is not None else pitched
    return (point.frequency if pitched and active else None), active


def _performance_metrics(
    reference: LyricsDocument,
    actual: Sequence[PitchPoint],
    adjustments: Sequence[PlaybackAdjustment],
    performance_duration: float | None,
    note_score: Mapping[str, object] | None,
) -> tuple[float, float]:
    """Rhythm and stability: the values scored live during the song win over a recomputation."""
    rhythm, stability = _note_metrics(
        reference, actual, adjustments, performance_duration or reference.duration
    )
    saved_rhythm = _saved_percentage(note_score, "rhythmAccuracyPercent")
    saved_stability = _saved_percentage(note_score, "noteStabilityPercent")
    return (
        saved_rhythm if saved_rhythm is not None else rhythm,
        saved_stability if saved_stability is not None else stability,
    )


def _note_metrics(
    reference: LyricsDocument,
    actual: Sequence[PitchPoint],
    adjustments: Sequence[PlaybackAdjustment],
    performance_duration: float,
) -> tuple[float, float]:
    intervals = _played_source_intervals(adjustments, max(0.0, performance_duration))
    notes = _played_notes(reference, intervals)
    if not notes:
        return 0.0, 0.0

    samples = _group_note_samples(reference, actual, adjustments, performance_duration, notes)
    rhythm_scores, stability_scores = zip(
        *(_score_note(note, samples.get(key, ())) for key, note in notes.items()), strict=True
    )
    return statistics.mean(rhythm_scores), statistics.mean(stability_scores)


def _group_note_samples(
    reference: LyricsDocument,
    actual: Sequence[PitchPoint],
    adjustments: Sequence[PlaybackAdjustment],
    performance_duration: float,
    notes: Mapping[tuple[int, int], Note],
) -> dict[tuple[int, int], list[tuple[float, float, float]]]:
    sample_seconds = _pitch_sample_seconds(actual)
    samples: dict[tuple[int, int], list[tuple[float, float, float]]] = {}
    for point in actual:
        if point.confidence < 0.3 or point.frequency <= 0 or point.time > performance_duration:
            continue
        adjustment = _adjustment_at(adjustments, point.time)
        rate = adjustment.playback_rate if adjustment is not None else 1.0
        source_time = _source_time(point.time, adjustment)
        located = _indexed_note_at(reference, source_time)
        if located is None or located[0] not in notes:
            continue
        key, note = located
        key_shift = adjustment.key_shift if adjustment is not None else 0.0
        expected = 440.0 * (2.0 ** ((note.note + key_shift - 69) / 12.0))
        signed_deviation = 12.0 * math.log2(point.frequency / expected)
        samples.setdefault(key, []).append((source_time, signed_deviation, sample_seconds * rate))
    return samples


def _score_note(note: Note, values: Sequence[tuple[float, float, float]]) -> tuple[float, float]:
    if not values:
        return 0.0, 0.0
    duration = max(1e-6, note.end - note.start)
    onset = min(value[0] for value in values)
    offset = max(value[0] + value[2] for value in values)
    covered = max(0.0, min(note.end, offset) - max(note.start, onset))
    deviations = [value[1] for value in values]
    spread = statistics.pstdev(deviations) if len(deviations) >= 2 else 2.0
    return 100.0 * min(1.0, covered / duration), 100.0 * max(0.0, 1.0 - spread)


def _saved_note_percentage(note_score: Mapping[str, object] | None) -> float | None:
    hit, total = (note_score or {}).get("hitNotes"), (note_score or {}).get("totalNotes")
    if (
        isinstance(hit, bool)
        or not isinstance(hit, int)
        or isinstance(total, bool)
        or not isinstance(total, int)
        or hit < 0
        or total <= 0
        or hit > total
    ):
        return None
    return 100.0 * hit / total


def _saved_percentage(note_score: Mapping[str, object] | None, key: str) -> float | None:
    if note_score is None:
        return None
    value = note_score.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) and 0.0 <= number <= 100.0 else None


def _green_note_percentage(
    reference: LyricsDocument,
    actual: Sequence[PitchPoint],
    adjustments: Sequence[PlaybackAdjustment],
    performance_duration: float,
) -> float:
    duration = max(0.0, performance_duration)
    notes = _played_notes(reference, _played_source_intervals(adjustments, duration))
    if not notes:
        return 0.0

    sample_seconds = _pitch_sample_seconds(actual)
    matched: dict[tuple[int, int], float] = {}
    for point in actual:
        if point.confidence < 0.3 or point.time > duration:
            continue
        adjustment = _adjustment_at(adjustments, point.time)
        rate = adjustment.playback_rate if adjustment is not None else 1.0
        source_time = _source_time(point.time, adjustment)
        located = _indexed_note_at(reference, source_time)
        if located is None:
            continue
        key, note = located
        _, deviation = _compare(
            point, note, source_time, adjustment.key_shift if adjustment else 0.0
        )
        if deviation is not None and deviation <= KARAOKE_PITCH_TOLERANCE_SEMITONES:
            matched[key] = matched.get(key, 0.0) + sample_seconds * rate

    green = sum(
        1
        for key, note in notes.items()
        if matched.get(key, 0.0) + 1e-9 >= (note.end - note.start) * GREEN_NOTE_COVERAGE
    )
    return 100.0 * green / len(notes)


def _played_notes(
    reference: LyricsDocument, intervals: Sequence[tuple[float, float]]
) -> dict[tuple[int, int], Note]:
    """The song's notes (keyed by word and note index) that fall inside the performed span."""
    return {
        (word_index, note_index): note
        for word_index, word in enumerate(reference.words)
        for note_index, note in enumerate(word.notes)
        if any(note.start < end and note.end > start for start, end in intervals)
    }


def _source_time(elapsed: float, adjustment: PlaybackAdjustment | None) -> float:
    """The song moment sung at `elapsed` seconds of the performance, given its tempo change."""
    if adjustment is None:
        return elapsed
    return (
        adjustment.source_seconds
        + (elapsed - adjustment.elapsed_seconds) * adjustment.playback_rate
    )


def _pitch_sample_seconds(actual: Sequence[PitchPoint]) -> float:
    times = sorted(point.time for point in actual if point.confidence >= 0.3)
    steps = [later - earlier for earlier, later in pairwise(times) if 0 < later - earlier <= 0.2]
    return statistics.median(steps) if steps else 0.05


def _played_source_intervals(
    adjustments: Sequence[PlaybackAdjustment], duration: float
) -> tuple[tuple[float, float], ...]:
    if not adjustments:
        return ((0.0, duration),)
    initial_end = min(duration, adjustments[0].elapsed_seconds)
    result: list[tuple[float, float]] = [(0.0, initial_end)] if initial_end > 0 else []
    for index, adjustment in enumerate(adjustments):
        end_elapsed = (
            adjustments[index + 1].elapsed_seconds if index + 1 < len(adjustments) else duration
        )
        end_elapsed = min(duration, end_elapsed)
        if end_elapsed <= adjustment.elapsed_seconds:
            continue
        source_end = _source_time(end_elapsed, adjustment)
        start, end = sorted((adjustment.source_seconds, source_end))
        result.append((start, end))
    return tuple(result)


def _indexed_note_at(document: LyricsDocument, time: float) -> tuple[tuple[int, int], Note] | None:
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
    source_time = _source_time(point.time, adjustment)
    located = _indexed_note_at(reference, source_time)
    return _compare(
        point,
        located[1] if located is not None else None,
        source_time,
        adjustment.key_shift if adjustment is not None else 0.0,
    )


def parse_playback_adjustments(
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


def _sections(
    samples: Sequence[tuple[float, float]],
    duration: float,
    expected_times: Sequence[float] | None = None,
) -> tuple[SectionResult, ...]:
    result: list[SectionResult] = []
    step = 10.0
    start = 0.0
    while start < duration:
        end = min(duration, start + step)
        values = [value for time, value in samples if start <= time < end]
        total = (
            sum(start <= time < end for time in expected_times)
            if expected_times is not None
            else len(values)
        )
        if total:
            result.append(
                SectionResult(
                    start,
                    end,
                    100.0
                    * sum(1 for value in values if value <= KARAOKE_PITCH_TOLERANCE_SEMITONES)
                    / total,
                    sum(values) / len(values) if values else 0.0,
                )
            )
        start = end
    return tuple(result)
