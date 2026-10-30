from __future__ import annotations

import math
from dataclasses import dataclass, replace
from itertools import pairwise
from statistics import median
from typing import Sequence

from backend.ai.domain import PitchPoint, WordTiming
from backend.lyrics.domain import LyricsDocument, Note, Word

_CONFIDENCE_THRESHOLD = 0.5
# Only bridge a brief detector dropout when every intervening audio frame remains audible.
_MAX_PITCH_DROPOUT_SECONDS = 0.12
_DEFAULT_PITCH_STEP_SECONDS = 0.01
# Covers the existing 10 ms CREPE and 50 ms recording tracker; sparse samples cannot prove a hold.
_MAX_PITCH_STEP_SECONDS = 0.05
# Cost of starting a new note in the piecewise-constant fit, in semitone-frames (10 ms frames): a pitch
# change is only worth a new note once keeping it costs more than that much of deviation. Vibrato and
# a voice wavering around a semitone boundary stay well under it; a held interval passes it quickly.
_NOTE_CHANGE_COST = 8.0
# One frame never costs more than this in the fit, so an octave error or a cracked frame weighs like
# an ordinary miss instead of forcing its own note.
_MAX_FRAME_DEVIATION = 2.0


@dataclass(frozen=True, slots=True)
class MusicMetadata:
    bpm: float | None
    key: str | None


def stabilize_pitch(points: Sequence[PitchPoint]) -> tuple[PitchPoint, ...]:
    if not points:
        return ()
    corrected = iter(
        point for run in _pitch_runs(points, _pitch_step(points)) for point in _stabilized_run(run)
    )
    return tuple(next(corrected) if _has_pitch(point) else point for point in points)


def _stabilized_run(points: Sequence[PitchPoint]) -> tuple[PitchPoint, ...]:
    if len(points) < 3:
        return tuple(points)
    semitones = [_frequency_to_midi(point.frequency) for point in points]
    stable: list[PitchPoint] = []
    for index, point in enumerate(points):
        left = max(0, index - 1)
        right = min(len(points), index + 2)
        local = semitones[left:right]
        target = median(local)
        original = semitones[index]
        corrected = _correct_subharmonic(original, target)
        frequency = 440.0 * (2.0 ** ((corrected - 69.0) / 12.0))
        stable.append(replace(point, frequency=frequency))
    return tuple(stable)


def construct_document(
    title: str,
    artist: str,
    duration: float,
    lyrics: str,
    words: Sequence[WordTiming],
    pitch: Sequence[PitchPoint],
    music: MusicMetadata,
) -> LyricsDocument:
    # Fit the performed melody before cutting it at lyric boundaries. Otherwise
    # a short word on the crest of vibrato becomes an invented semitone change.
    melody = _notes_from_points(pitch, 0.0, duration)
    mapped_words = tuple(_word_with_notes(word, pitch, melody) for word in words)
    activity = _vocal_activity(
        [point for point in pitch if any(word.start <= point.time < word.end for word in words)],
        duration,
    )
    document = LyricsDocument(
        title,
        artist,
        duration,
        music.bpm,
        music.key,
        _phrase_lines(lyrics, words, activity),
        mapped_words,
        activity,
    )
    document.validate()
    return document


def _phrase_lines(
    lyrics: str, words: Sequence[WordTiming], activity: Sequence[tuple[float, float]]
) -> str:
    """Persist readable phrases at written boundaries, breaths, and the eight-word limit."""
    boundaries: set[int] = set()
    count = 0
    for line in lyrics.splitlines():
        count += len(line.split())
        boundaries.add(count)
    if count != len(words):
        return lyrics
    pauses = [
        (left[1], right[0]) for left, right in pairwise(activity) if right[0] - left[1] >= 0.35
    ]
    lines: list[list[str]] = []
    for index, word in enumerate(words):
        if not lines or (
            index in boundaries
            or len(lines[-1]) >= 8
            or word.start - words[index - 1].end >= 0.35
            or any(
                words[index - 1].start < start < word.start and end <= word.start + 0.15
                for start, end in pauses
            )
        ):
            lines.append([])
        lines[-1].append(word.text)
    return "\n".join(" ".join(line) for line in lines)


def _word_with_notes(word: WordTiming, pitch: Sequence[PitchPoint], melody: Sequence[Note]) -> Word:
    points = [point for point in pitch if word.start <= point.time <= word.end]
    notes = [
        replace(note, start=max(word.start, note.start), end=min(word.end, note.end))
        for note in melody
        if note.start < word.end and note.end > word.start
    ]
    measured = tuple(
        replace(
            note,
            contour=tuple(
                (fraction, values[0], values[1])
                for fraction, values in {
                    (point.time - note.start) / (note.end - note.start): (
                        _frequency_to_midi(point.frequency) - note.note
                        if point.frequency > 0
                        else 0.0,
                        point.confidence
                        if point.frequency > 0 and point.audio_active is not False
                        else 0.0,
                    )
                    for point in points
                    if note.start <= point.time < note.end
                }.items()
            ),
        )
        for note in notes
    )
    return Word(word.text, word.start, word.end, measured, word.letters)


def _vocal_activity(
    points: Sequence[PitchPoint], duration: float
) -> tuple[tuple[float, float], ...]:
    step = _pitch_step(points)
    intervals: list[tuple[float, float]] = []
    for point in points:
        if point.audio_active is False or (point.audio_active is None and not _has_pitch(point)):
            continue
        start, end = max(0.0, point.time - step / 2), min(duration, point.time + step / 2)
        if end <= start:
            continue
        if intervals and start <= intervals[-1][1] + 1e-8:
            intervals[-1] = (intervals[-1][0], max(intervals[-1][1], end))
        else:
            intervals.append((start, end))
    return tuple(intervals)


def _notes_from_points(points: Sequence[PitchPoint], start: float, end: float) -> tuple[Note, ...]:
    if not points:
        return ()
    step = _pitch_step(points)
    return tuple(
        note
        for run in _pitch_runs(points, step)
        for note in _notes_for_run(run, start, min(end, run[-1].time + step), step)
    )


def _pitch_step(points: Sequence[PitchPoint]) -> float:
    deltas = [right.time - left.time for left, right in pairwise(points) if right.time > left.time]
    return min(median(deltas), _MAX_PITCH_STEP_SECONDS) if deltas else _DEFAULT_PITCH_STEP_SECONDS


def _has_pitch(point: PitchPoint) -> bool:
    return (
        point.confidence >= _CONFIDENCE_THRESHOLD
        and point.frequency > 20
        and point.audio_active is not False
    )


def _pitch_runs(points: Sequence[PitchPoint], step: float) -> list[list[PitchPoint]]:
    runs: list[list[PitchPoint]] = []
    current: list[PitchPoint] = []
    previous = points[0].time
    for point in points:
        continuous = point.time - previous <= step * 1.5
        if current and (
            not continuous or point.time - current[-1].time > _MAX_PITCH_DROPOUT_SECONDS
        ):
            runs.append(current)
            current = []
        if _has_pitch(point):
            current.append(point)
        elif current and point.audio_active is not True:
            runs.append(current)
            current = []
        previous = point.time
    if current:
        runs.append(current)
    return runs


def _notes_for_run(
    points: Sequence[PitchPoint], start: float, end: float, step: float
) -> tuple[Note, ...]:
    pitches = [_frequency_to_midi(point.frequency) for point in points]
    notes: list[Note] = []
    for position, (first, last) in enumerate(_held_segments(pitches, step)):
        # Rounding each frame on its own flips between two semitones whenever the voice sits near their
        # boundary or carries vibrato; the median of the whole held segment is the pitch actually sung.
        note = round(median(pitches[first : last + 1]))
        note_start = max(start, points[first].time) if position == 0 else points[first].time
        notes.append(Note(note, note_start, end))
        if position > 0:
            previous = notes[-2]
            notes[-2] = Note(previous.note, previous.start, note_start)
    # A segment starting on the word's very last instant has no time left to be sung.
    return tuple(_merged_repeats([note for note in notes if note.end > note.start]))


def _held_segments(pitches: Sequence[float], step: float) -> list[tuple[int, int]]:
    """Fits the contour with constant notes, paying _NOTE_CHANGE_COST for every new one (Viterbi), and
    returns the first/last frame index of each fitted note."""
    low = math.floor(min(pitches)) - 1
    candidates = range(low, math.ceil(max(pitches)) + 2)
    weight = step / _DEFAULT_PITCH_STEP_SECONDS
    cost = [_frame_cost(pitches[0], note) * weight for note in candidates]
    origins: list[list[int]] = []
    for pitch in pitches[1:]:
        best = min(range(len(cost)), key=cost.__getitem__)
        switch = cost[best] + _NOTE_CHANGE_COST
        origin = [index if value <= switch else best for index, value in enumerate(cost)]
        cost = [
            min(value, switch) + _frame_cost(pitch, note) * weight
            for value, note in zip(cost, candidates, strict=True)
        ]
        origins.append(origin)
    state = min(range(len(cost)), key=cost.__getitem__)
    path = [state]
    for origin in reversed(origins):
        state = origin[state]
        path.append(state)
    path.reverse()
    segments: list[tuple[int, int]] = []
    first = 0
    for index in range(1, len(path) + 1):
        if index == len(path) or path[index] != path[first]:
            segments.append((first, index - 1))
            first = index
    return segments


def _frame_cost(pitch: float, note: int) -> float:
    return min(abs(pitch - note), _MAX_FRAME_DEVIATION)


def _merged_repeats(notes: list[Note]) -> list[Note]:
    merged: list[Note] = []
    for note in notes:
        if merged and merged[-1].note == note.note and math.isclose(merged[-1].end, note.start):
            merged[-1] = Note(note.note, merged[-1].start, note.end)
        else:
            merged.append(note)
    return merged


def _frequency_to_midi(frequency: float) -> float:
    return 69.0 + 12.0 * math.log2(frequency / 440.0)


def _correct_subharmonic(value: float, target: float) -> float:
    candidates = (value - 12.0, value, value + 12.0)
    return min(candidates, key=lambda candidate: abs(candidate - target))
