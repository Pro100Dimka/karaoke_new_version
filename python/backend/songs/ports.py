from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, Sequence

from backend.songs.domain import Song, SongStatus


@dataclass(frozen=True, slots=True)
class SongPage:
    items: Sequence[Song]
    next_cursor: str | None


@dataclass(frozen=True, slots=True)
class MediaMetadata:
    title: str
    artist: str
    album: str | None
    duration: float | None
    media_format: str | None
    embedded_lyrics: str | None
    has_embedded_artwork: bool


class SongRepository(Protocol):
    def get(self, song_id: str) -> Song | None: ...

    def get_by_source_identity(self, identity: str) -> Song | None: ...

    def add(self, song: Song) -> None: ...

    def update(self, song: Song) -> None: ...

    def delete(self, song_id: str) -> None: ...

    def list(
        self,
        *,
        search: str | None,
        status: SongStatus | None,
        sort: str,
        descending: bool,
        limit: int,
        offset: int,
    ) -> Sequence[Song]: ...

    def count(self, *, search: str | None, status: SongStatus | None) -> int: ...


class MediaInspector(Protocol):
    def inspect(self, source: Path) -> MediaMetadata: ...

    def extract_artwork(self, source: Path, target: Path) -> bool: ...


class SongStorage(Protocol):
    def copy_source(self, song_id: str, source: Path, expected_hash: str) -> Path: ...

    def copy_cover(self, song_id: str, source: Path) -> Path: ...

    def quarantine(self, song_id: str) -> Path | None: ...

    def quarantine_path(self, song_id: str) -> Path: ...

    def restore_quarantine(self, song_id: str, quarantine_path: Path) -> None: ...

    def finalize_quarantine(self, quarantine_path: Path) -> None: ...

    def exists(self, path: Path) -> bool: ...

    def size(self, path: Path) -> int: ...


class FileHasher(Protocol):
    def hash_file(self, path: Path) -> str: ...
