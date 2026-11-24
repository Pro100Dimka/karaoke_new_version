from __future__ import annotations

from dataclasses import dataclass

from backend.lyrics.domain import LyricsDocument


@dataclass(frozen=True, slots=True)
class EditorDocument:
    song_id: str
    revision: int
    document: LyricsDocument
    document_fingerprint: str


@dataclass(frozen=True, slots=True)
class EditorSaveResult:
    revision: int
    document_fingerprint: str
