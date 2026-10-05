from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from backend.text_normalization import normalize_catalog_identity


def prefer_equivalent_local_spelling(local: str, recognized: str | None) -> str:
    """Keep local script only when both values identify exactly the same text."""
    if not recognized:
        return local
    normalized_local = normalize_catalog_identity(local)
    if normalized_local and normalized_local == normalize_catalog_identity(recognized):
        return local
    return recognized


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
