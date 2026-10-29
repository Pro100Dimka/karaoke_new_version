from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Protocol, Sequence

from backend.songs.domain import Language, Song, SongStatus


@dataclass(frozen=True, slots=True)
class SongFilters:
    statuses: tuple[SongStatus, ...] | None = None
    language: Language | None = None
    duration: str = "all"
    artwork: str = "all"


@dataclass(frozen=True, slots=True)
class SongSummary:
    total: int
    ready: int
    languages: Sequence[Language]


@dataclass(frozen=True, slots=True)
class SongPage:
    items: Sequence[Song]
    next_cursor: str | None
    total: int = 0


SongSortValue = str | float | datetime


@dataclass(frozen=True, slots=True)
class SongSearchPage:
    items: Sequence[Song]
    next_key: tuple[SongSortValue, str] | None


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
        filters: SongFilters | None = None,
    ) -> Sequence[Song]: ...

    def count(
        self, *, search: str | None, status: SongStatus | None, filters: SongFilters | None = None
    ) -> int: ...

    def search(
        self, *, search: str | None, status: SongStatus | None, sort: str,
        descending: bool, limit: int, after: tuple[SongSortValue, str] | None,
        filters: SongFilters | None = None,
    ) -> SongSearchPage: ...

    def summary(self) -> SongSummary: ...


class MediaInspector(Protocol):
    def inspect(self, source: Path) -> MediaMetadata: ...

    def extract_artwork(self, source: Path, target: Path) -> bool: ...

    def waveform_peaks(self, source: Path, bins: int) -> list[float]: ...


class SongStorage(Protocol):
    def copy_source(self, song_id: str, source: Path, expected_hash: str) -> Path: ...

    def copy_cover(self, song_id: str, source: Path) -> Path: ...

    def quarantine(self, song_id: str) -> Path | None: ...

    def quarantine_path(self, song_id: str) -> Path: ...

    def restore_quarantine(self, song_id: str, quarantine_path: Path) -> None: ...

    def finalize_quarantine(self, quarantine_path: Path) -> None: ...

    def exists(self, path: Path) -> bool: ...

    def size(self, path: Path) -> int: ...


FileHasher = Callable[[Path], str]
