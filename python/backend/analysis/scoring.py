from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

from backend.ai.domain import PitchPoint
from backend.analysis.domain import SectionResult
from backend.lyrics.domain import LyricsDocument, Note


@dataclass(frozen=True, slots=True)
class ScoreSummary:
    pitch_accuracy_percent: float
    mean_semitone_deviation: float
    sections: Sequence[SectionResult]
    problem_regions: Sequence[dict[str, float]]


def score_pitch(reference: LyricsDocument, actual: Sequence[PitchPoint]) -> ScoreSummary:
    samples = [
        _compare(point, _note_at(reference, point.time))
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


def _note_at(document: LyricsDocument, time: float) -> Note | None:
    for word in document.words:
        if word.start <= time <= word.end:
            for note in word.notes:
                if note.start <= time <= note.end:
                    return note
    return None


def _compare(point: PitchPoint, note: Note | None) -> tuple[float, float | None]:
    if note is None or point.frequency <= 0:
        return point.time, None
    expected = 440.0 * (2.0 ** ((note.note - 69) / 12.0))
    deviation = abs(12.0 * math.log2(point.frequency / expected))
    return point.time, deviation


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
