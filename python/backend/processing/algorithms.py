from __future__ import annotations

import math
from dataclasses import dataclass
from statistics import median
from typing import Sequence

from backend.ai.domain import PitchPoint, WordTiming
from backend.lyrics.domain import LyricsDocument, Note, Word
from backend.moment_spreading import TIE_EPSILON_SECONDS, spread_tied_moments

_CONFIDENCE_THRESHOLD = 0.5
# torchcrepe's window (64 ms, backend/ai_worker/pitch.py) plus its 3-frame confidence smoothing.
_PITCH_ONSET_LAG_SECONDS = 0.05
# A note shorter than this cannot be seen, reached and held by a singer before it is gone, so inside a
# word it is folded into a neighbour instead of being drawn on its own.
_MIN_NOTE_DURATION = 0.12
# Cost of starting a new note in the piecewise-constant fit, in semitone-frames (10 ms frames): a pitch
# change is only worth a new note once keeping it costs more than that much of deviation. Vibrato and
# a voice wavering around a semitone boundary stay well under it; a held interval passes it quickly.
_NOTE_CHANGE_COST = 8.0
# One frame never costs more than this in the fit, so an octave error or a cracked frame weighs like
# an ordinary miss instead of forcing its own note.
_MAX_FRAME_DEVIATION = 2.0
# A singer scooping into a note (or falling off it) slides through the pitches between; a short note
# strictly between both neighbours, within this span, is that slide and belongs to the held note.
_PASSING_NOTE_MAX_DURATION = 0.25
_PASSING_NOTE_MAX_SPAN = 4


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
        # The pitch tracker centres a 64 ms analysis window on each point and then median-smooths
        # confidence over 3 more frames, so the first point that reads as voiced typically lands after
        # singing has genuinely already started -- worst right after silence, which is exactly where a
        # late start is most visible. Backing the boundary off by that same lag costs at most a sliver of
        # trailing silence (unnoticeable) in exchange for never narrowing later than the voice truly began.
        start = max(word.start, min(voiced) - _PITCH_ONSET_LAG_SECONDS)
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
    pitches = [_frequency_to_midi(point.frequency) for point in points]
    notes: list[Note] = []
    for position, (first, last) in enumerate(_held_segments(pitches)):
        # Rounding each frame on its own flips between two semitones whenever the voice sits near their
        # boundary or carries vibrato; the median of the whole held segment is the pitch actually sung.
        note = round(median(pitches[first : last + 1]))
        note_start = max(start, points[first].time) if position == 0 else points[first].time
        notes.append(Note(note, note_start, end))
        if position > 0:
            previous = notes[-2]
            notes[-2] = Note(previous.note, previous.start, note_start)
    # A segment starting on the word's very last instant has no time left to be sung.
    return _singable([note for note in notes if note.end > note.start])


def _held_segments(pitches: Sequence[float]) -> list[tuple[int, int]]:
    """Fits the contour with constant notes, paying _NOTE_CHANGE_COST for every new one (Viterbi), and
    returns the first/last frame index of each fitted note."""
    low = math.floor(min(pitches)) - 1
    candidates = range(low, math.ceil(max(pitches)) + 2)
    cost = [_frame_cost(pitches[0], note) for note in candidates]
    origins: list[list[int]] = []
    for pitch in pitches[1:]:
        best = min(range(len(cost)), key=cost.__getitem__)
        switch = cost[best] + _NOTE_CHANGE_COST
        origin = [index if value <= switch else best for index, value in enumerate(cost)]
        cost = [
            min(value, switch) + _frame_cost(pitch, note)
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


def _singable(notes: list[Note]) -> tuple[Note, ...]:
    """Folds slides and too-short notes into their neighbours until every note can be sung."""
    while True:
        notes = _merged_repeats(notes)
        index = _passing_note(notes)
        if index is not None:
            # A slide leads into (or out of) the note actually held, which is the longer neighbour.
            _absorb(notes, index, max((index - 1, index + 1), key=lambda n: _length(notes[n])))
            continue
        index = _shortest_brief_note(notes)
        if index is None:
            return tuple(notes)
        _absorb(notes, index, _absorbing_neighbour(notes, index))


def _merged_repeats(notes: list[Note]) -> list[Note]:
    merged: list[Note] = []
    for note in notes:
        if merged and merged[-1].note == note.note:
            merged[-1] = Note(note.note, merged[-1].start, note.end)
        else:
            merged.append(note)
    return merged


def _passing_note(notes: Sequence[Note]) -> int | None:
    for index in range(1, len(notes) - 1):
        previous, current, following = notes[index - 1], notes[index], notes[index + 1]
        between = previous.note < current.note < following.note or (
            previous.note > current.note > following.note
        )
        if (
            between
            and _length(current) < _PASSING_NOTE_MAX_DURATION
            and abs(following.note - previous.note) <= _PASSING_NOTE_MAX_SPAN
        ):
            return index
    return None


def _shortest_brief_note(notes: Sequence[Note]) -> int | None:
    if len(notes) < 2:
        return None
    index = min(range(len(notes)), key=lambda position: _length(notes[position]))
    return index if _length(notes[index]) < _MIN_NOTE_DURATION else None


def _absorbing_neighbour(notes: Sequence[Note], index: int) -> int:
    """The neighbour closest in pitch (the longer one on a tie) takes over a folded note's time."""
    neighbours = [position for position in (index - 1, index + 1) if 0 <= position < len(notes)]
    return min(
        neighbours,
        key=lambda position: (
            abs(notes[position].note - notes[index].note),
            -_length(notes[position]),
        ),
    )


def _length(note: Note) -> float:
    return note.end - note.start


def _absorb(notes: list[Note], index: int, neighbour: int) -> None:
    folded, keeper = notes[index], notes[neighbour]
    if neighbour < index:
        notes[neighbour] = Note(keeper.note, keeper.start, folded.end)
    else:
        notes[neighbour] = Note(keeper.note, folded.start, keeper.end)
    del notes[index]


def _frequency_to_midi(frequency: float) -> float:
    return 69.0 + 12.0 * math.log2(frequency / 440.0)


def _correct_subharmonic(value: float, target: float) -> float:
    candidates = (value - 12.0, value, value + 12.0)
    return min(candidates, key=lambda candidate: abs(candidate - target))
