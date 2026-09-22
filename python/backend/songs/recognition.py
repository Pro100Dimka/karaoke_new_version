from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


@dataclass(frozen=True, slots=True)
class RecognizedSong:
    title: str
    artist: str
    album: str | None = None
    genre: str | None = None
    artwork_url: str | None = None
    video_url: str | None = None
    provider: str = ""
    external_id: str | None = None


class SongRecognitionProvider(Protocol):
    def recognize(self, source: Path) -> RecognizedSong | None: ...


class DisabledSongRecognitionProvider:
    def recognize(self, source: Path) -> RecognizedSong | None:
        del source
        return None
