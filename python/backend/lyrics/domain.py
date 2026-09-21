from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence


@dataclass(frozen=True, slots=True)
class Note:
    note: int
    start: float
    end: float

    def validate_within(self, word_start: float, word_end: float) -> None:
        if self.start < word_start or self.end > word_end or self.end <= self.start:
            raise ValueError("Note timing must be inside its word and have positive duration")


@dataclass(frozen=True, slots=True)
class Word:
    text: str
    start: float
    end: float
    notes: Sequence[Note]

    def validate(self) -> None:
        if self.end <= self.start:
            raise ValueError("Word timing must have positive duration")
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
        if self.duration <= 0:
            raise ValueError("Duration must be positive")
        for word in self.words:
            word.validate()
        for previous, current in zip(self.words, self.words[1:], strict=False):
            if current.start < previous.start:
                raise ValueError("Words must be ordered by start time")
