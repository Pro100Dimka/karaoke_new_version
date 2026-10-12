from __future__ import annotations

from dataclasses import dataclass
from math import isfinite
from typing import Sequence


@dataclass(frozen=True, slots=True)
class Note:
    note: int
    start: float
    end: float

    def validate_within(self, word_start: float, word_end: float) -> None:
        if not word_start <= self.start < self.end <= word_end:
            raise ValueError("Note timing must be inside its word and have positive duration")


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
