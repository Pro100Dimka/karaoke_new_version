from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, Sequence

from backend.songs.domain import Language, Song


@dataclass(frozen=True, slots=True)
class LyricLineTiming:
    start: float
    text: str


@dataclass(frozen=True, slots=True)
class LyricsCandidate:
    lyrics: str
    title: str
    artist: str
    duration: float | None
    provider_id: str
    timing_hints: tuple[LyricLineTiming, ...] = ()


class OnlineLyricsProvider(Protocol):
    @property
    def provider_id(self) -> str: ...

    def search(
        self,
        song: Song,
        language: Language,
        cancel: threading.Event,
    ) -> Sequence[LyricsCandidate]: ...


class SidecarLyricsReader(Protocol):
    def read(self, source: Path) -> str | None: ...
