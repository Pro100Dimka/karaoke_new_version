from __future__ import annotations

from dataclasses import dataclass

from backend.lyrics.domain import LyricsDocument


@dataclass(frozen=True, slots=True)
class EditorDocument:
    song_id: str
    revision: int
    document: LyricsDocument
