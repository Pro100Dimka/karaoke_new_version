from __future__ import annotations

from dataclasses import dataclass
from math import isfinite
from bisect import bisect_left
from typing import Sequence


@dataclass(frozen=True, slots=True)
class Note:
    note: int
    start: float
    end: float
    # Relative time (0..1), semitone offset: edits move/resize this measured target with its note.
    contour: Sequence[tuple[float, float]] = ()

    def validate_within(self, word_start: float, word_end: float) -> None:
        if not word_start <= self.start < self.end <= word_end:
            raise ValueError("Note timing must be inside its word and have positive duration")
        if any(not 0 <= moment <= 1 or not isfinite(offset) for moment, offset in self.contour):
            raise ValueError("Note contour must contain finite offsets at relative times 0..1")
        if any(right[0] <= left[0] for left, right in zip(self.contour, self.contour[1:], strict=False)):
            raise ValueError("Note contour times must increase")

    def pitch_at(self, time: float) -> float:
        if not self.contour:
            return float(self.note)
        fraction = (time - self.start) / (self.end - self.start)
        index = bisect_left(self.contour, fraction, key=lambda point: point[0])
        right = self.contour[min(index, len(self.contour) - 1)]
        left = self.contour[max(0, index - 1)]
        weight = min(1.0, max(0.0, (fraction - left[0]) / (right[0] - left[0]))) if right[0] > left[0] else 0.0
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

    def validate(self) -> None:
        if not isfinite(self.duration) or self.duration <= 0:
            raise ValueError("Duration must be finite and positive")
        for word in self.words:
            word.validate()
            if word.end > self.duration:
                raise ValueError("Word timing must be inside the song duration")
        for previous, current in zip(self.words, self.words[1:], strict=False):
            if current.start < previous.start:
                raise ValueError("Words must be ordered by start time")
