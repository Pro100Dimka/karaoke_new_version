from __future__ import annotations

import math
from dataclasses import dataclass
from statistics import median
from typing import Sequence

from backend.ai.domain import PitchPoint, WordTiming
from backend.lyrics.domain import LyricsDocument, Note, Word
from backend.moment_spreading import TIE_EPSILON_SECONDS, spread_tied_moments

_CONFIDENCE_THRESHOLD = 0.5
_MIN_NOTE_DURATION = 0.06


@dataclass(frozen=True, slots=True)
class MusicMetadata:
    bpm: float | None
    key: str | None


def stabilize_pitch(points: Sequence[PitchPoint]) -> tuple[PitchPoint, ...]:
    valid = [
        point
        for point in points
        if point.confidence >= _CONFIDENCE_THRESHOLD and point.frequency > 20
    ]
    if len(valid) < 3:
        return tuple(valid)
    semitones = [_frequency_to_midi(point.frequency) for point in valid]
    stable: list[PitchPoint] = []
    for index, point in enumerate(valid):
        left = max(0, index - 1)
        right = min(len(valid), index + 2)
        local = semitones[left:right]
        target = median(local)
        original = semitones[index]
        corrected = _correct_subharmonic(original, target)
        frequency = 440.0 * (2.0 ** ((corrected - 69.0) / 12.0))
        stable.append(PitchPoint(point.time, frequency, point.confidence))
    return tuple(stable)


def refine_words(
    words: Sequence[WordTiming], pitch: Sequence[PitchPoint]
) -> tuple[WordTiming, ...]:
    refined: list[WordTiming] = []
    for word in words:
        voiced = [point.time for point in pitch if word.start <= point.time <= word.end]
        if not voiced:
            refined.append(word)
            continue
        start = max(word.start, min(voiced))
        end = min(word.end, max(voiced))
        # Pitch is only present while a vowel is sounding, so narrowing straight to it can swallow several
        # of the word's own already-placed letters at once -- typically unvoiced leading/trailing consonants,
        # which legitimately carry no pitch but were already given good, distinct timing by alignment.
        # Never narrow past the word's own second/second-to-last letter, so at most the very first or last
        # letter is absorbed into the new boundary instead of a whole run of them being crushed together.
        if len(word.letters) > 1:
            # Landing exactly on the preserved letter would glue the absorbed one to it just the same, one
            # letter later; backing off by twice the tie epsilon keeps them apart even after spread_tied_moments
            # below, which would otherwise read a boundary landing within one epsilon of it as still tied and
            # halve the gap again trying to spread it.
            margin = 2 * TIE_EPSILON_SECONDS
            start = max(word.start, min(start, word.letters[1] - margin))
            end = min(word.end, max(end, word.letters[-2] + margin))
        end = max(end, start + 0.001)
        # Narrowing the word to where pitch was actually detected can clamp several of its opening
        # letters onto the same new start; spreading them keeps the highlight visibly moving through
        # each one instead of a run of them flashing by together at once.
        clamped: list[float | None] = [min(max(moment, start), end) for moment in word.letters]
        letters = tuple(
            moment for moment in spread_tied_moments(clamped, end) if moment is not None
        )
        refined.append(WordTiming(word.text, start, end, word.confidence, letters))
    return tuple(refined)


def construct_document(
    title: str,
    artist: str,
    duration: float,
    lyrics: str,
    words: Sequence[WordTiming],
    pitch: Sequence[PitchPoint],
    music: MusicMetadata,
) -> LyricsDocument:
    mapped_words = tuple(_word_with_notes(word, pitch) for word in words)
    document = LyricsDocument(title, artist, duration, music.bpm, music.key, lyrics, mapped_words)
    document.validate()
    return document


def _word_with_notes(word: WordTiming, pitch: Sequence[PitchPoint]) -> Word:
    points = [point for point in pitch if word.start <= point.time <= word.end]
    notes = _notes_from_points(points, word.start, word.end)
    return Word(word.text, word.start, word.end, notes, word.letters)


def _notes_from_points(points: Sequence[PitchPoint], start: float, end: float) -> tuple[Note, ...]:
    if not points:
        return ()
    groups: list[tuple[int, float, float]] = []
    current_note = round(_frequency_to_midi(points[0].frequency))
    group_start = max(start, points[0].time)
    previous_time = group_start
    for point in points[1:]:
        note = round(_frequency_to_midi(point.frequency))
        if note != current_note:
            _append_note(groups, current_note, group_start, previous_time, end)
            current_note = note
            group_start = point.time
        previous_time = point.time
    _append_note(groups, current_note, group_start, end, end)
    return _without_overlap(groups)


def _without_overlap(groups: Sequence[tuple[int, float, float]]) -> tuple[Note, ...]:
    """The minimum note length may not push a note over the next one: each note ends where the next begins."""
    notes: list[Note] = []
    for position, (note, start, end) in enumerate(groups):
        following = groups[position + 1][1] if position + 1 < len(groups) else end
        clipped_end = min(end, following)
        if clipped_end > start:
            notes.append(Note(note, start, clipped_end))
    return tuple(notes)


def _append_note(
    groups: list[tuple[int, float, float]],
    note: int,
    start: float,
    candidate_end: float,
    word_end: float,
) -> None:
    end = min(word_end, max(candidate_end, start + _MIN_NOTE_DURATION))
    if end > start:
        groups.append((note, start, end))


def _frequency_to_midi(frequency: float) -> float:
    return 69.0 + 12.0 * math.log2(frequency / 440.0)


def _correct_subharmonic(value: float, target: float) -> float:
    candidates = (value - 12.0, value, value + 12.0)
    return min(candidates, key=lambda candidate: abs(candidate - target))
