from __future__ import annotations

from dataclasses import dataclass
from math import isfinite, ceil
from bisect import bisect_left
from typing import Sequence, Iterator


@dataclass(frozen=True, slots=True)
class Note:
    note: int
    start: float
    end: float
    # Relative time (0..1), semitone offset: edits move/resize this measured target with its note.
    contour: Sequence[tuple[float, float, float]] = ()

    def validate_within(self, word_start: float, word_end: float) -> None:
        if not word_start <= self.start < self.end <= word_end:
            raise ValueError("Note timing must be inside its word and have positive duration")
        if any(
            not 0 <= moment <= 1 or not isfinite(offset) or not 0 <= confidence <= 1
            for moment, offset, confidence in self.contour
        ):
            raise ValueError("Note contour must contain finite offsets at relative times 0..1")
        if any(
            right[0] <= left[0] for left, right in zip(self.contour, self.contour[1:], strict=False)
        ):
            raise ValueError("Note contour times must increase")

    def pitch_at(self, time: float) -> float | None:
        if not self.contour:
            return float(self.note)
        fraction = (time - self.start) / (self.end - self.start)
        index = bisect_left(self.contour, fraction, key=lambda point: point[0])
        right = self.contour[min(index, len(self.contour) - 1)]
        left = self.contour[max(0, index - 1)]
        nearest = min((left, right), key=lambda point: abs(point[0] - fraction))
        if nearest[2] < 0.5:
            return None
        weight = (
            min(1.0, max(0.0, (fraction - left[0]) / (right[0] - left[0])))
            if right[0] > left[0]
            else 0.0
        )
        return self.note + left[1] + (right[1] - left[1]) * weight


@dataclass(frozen=True, slots=True)
class Word:
    text: str
    start: float
    end: float
    notes: Sequence[Note]
    # Start time of every character of ``text``, for highlighting the sung letter; may be empty.
    letters: Sequence[float] = ()

    def validate(self) -> None:
        if not 0 <= self.start < self.end or not isfinite(self.end):
            raise ValueError("Word timing must be finite, nonnegative and have positive duration")
        if self.letters and len(self.letters) != len(self.text):
            raise ValueError("Letter timings must cover every character of the word")
        if any(not self.start <= moment <= self.end for moment in self.letters):
            raise ValueError("Letter timing must be inside its word")
        if any(
            later < earlier for earlier, later in zip(self.letters, self.letters[1:], strict=False)
        ):
            raise ValueError("Letter timings must not go backwards")
        for note in self.notes:
            note.validate_within(self.start, self.end)
        for previous, current in zip(self.notes, self.notes[1:], strict=False):
            if current.start < previous.end:
                raise ValueError("Overlapping notes are not allowed")


@dataclass(frozen=True, slots=True)
class LyricsDocument:
    title: str
    artist: str
    duration: float
    bpm: float | None
    key: str | None
    lyrics: str
    words: Sequence[Word]
    # The vocal's activity includes consonants that have no reliable fundamental pitch.
    vocal_activity: Sequence[tuple[float, float]] = ()

    def validate(self) -> None:
        if not isfinite(self.duration) or self.duration <= 0:
            raise ValueError("Duration must be finite and positive")
        if any(not 0 <= start < end <= self.duration for start, end in self.vocal_activity):
            raise ValueError("Vocal activity must be inside the song")
        if any(
            right[0] < left[1]
            for left, right in zip(self.vocal_activity, self.vocal_activity[1:], strict=False)
        ):
            raise ValueError("Vocal activity intervals must not overlap")
        for word in self.words:
            word.validate()
            if word.end > self.duration:
                raise ValueError("Word timing must be inside the song duration")
        for previous, current in zip(self.words, self.words[1:], strict=False):
            if current.start < previous.start:
                raise ValueError("Words must be ordered by start time")

    def target_frames(self, step: float = 0.01) -> Iterator[tuple[float, float | None, bool]]:
        """Revision-bound pitch and vocal activity, independent of the detector grading a take."""
        notes = sorted(
            (note for word in self.words for note in word.notes), key=lambda note: note.start
        )
        starts = [note.start for note in notes]
        activity_starts = [interval[0] for interval in self.vocal_activity]
        for index in range(ceil(self.duration / step)):
            time = index * step
            position = bisect_left(starts, time + 1e-9) - 1
            note = notes[position] if position >= 0 and time < notes[position].end else None
            pitch = note.pitch_at(time) if note else None
            activity_index = bisect_left(activity_starts, time + 1e-9) - 1
            active = (
                activity_index >= 0 and time < self.vocal_activity[activity_index][1]
                if self.vocal_activity
                else note is not None
            )
            yield time, pitch, active
