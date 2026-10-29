from __future__ import annotations

import base64
import hashlib
import math
from dataclasses import dataclass
from datetime import datetime

from backend.domain_errors import DomainError, NotFoundError
from backend.persistence import UnitOfWorkFactory
from backend.songs.domain import Song, SongStatus
from backend.serialization import dumps, loads_object
from backend.songs.ports import MediaInspector, SongFilters, SongPage, SongSortValue, SongSummary


@dataclass(frozen=True, slots=True)
class ListSongsQuery:
    search: str | None = None
    status: SongStatus | None = None
    sort: str = "title"
    descending: bool = False
    limit: int = 50
    cursor: str | None = None
    filters: SongFilters | None = None


class GetSong:
    def __init__(self, uow: UnitOfWorkFactory) -> None:
        self._uow = uow

    def execute(self, song_id: str) -> Song:
        with self._uow.create() as transaction:
            song = transaction.songs.get(song_id)
        if song is None:
            raise NotFoundError("SongNotFound", "Song was not found", songId=song_id)
        return song


class GetSongWaveform:
    def __init__(self, songs: GetSong, media: MediaInspector) -> None:
        self._songs = songs
        self._media = media

    def execute(self, song_id: str, bins: int) -> list[float]:
        song = self._songs.execute(song_id)
        if song.source_path is None or not song.source_path.is_file():
            raise NotFoundError("SourceMissing", "Song source is unavailable")
        return self._media.waveform_peaks(song.source_path, bins)


class ListSongs:
    def __init__(self, uow: UnitOfWorkFactory, max_limit: int) -> None:
        self._uow = uow
        self._max_limit = max_limit

    def execute(self, query: ListSongsQuery) -> SongPage:
        if not 1 <= query.limit <= self._max_limit:
            raise DomainError("InvalidPageLimit", "Page limit is outside the allowed range", 400)
        offset = _decode_cursor(query.cursor)
        with self._uow.create() as transaction:
            items = transaction.songs.list(
                search=query.search,
                status=query.status,
                sort=query.sort,
                descending=query.descending,
                limit=query.limit,
                offset=offset,
                filters=query.filters,
            )
            total = transaction.songs.count(
                search=query.search, status=query.status, filters=query.filters
            )
        next_offset = offset + len(items)
        next_cursor = _encode_cursor(next_offset) if next_offset < total else None
        return SongPage(items, next_cursor, total)

    def summary(self) -> SongSummary:
        with self._uow.create() as transaction:
            return transaction.songs.summary()

    def search(self, query: ListSongsQuery) -> SongPage:
        if not 1 <= query.limit <= self._max_limit:
            raise DomainError("InvalidPageLimit", "Page limit is outside the allowed range", 400)
        signature = hashlib.sha256(dumps({
            "search": query.search, "status": query.status, "sort": query.sort,
            "descending": query.descending, "filters": query.filters,
        }).encode()).hexdigest()[:16]
        after, total = _decode_search_cursor(query.cursor, signature, query.sort)
        with self._uow.create() as transaction:
            page = transaction.songs.search(
                search=query.search, status=query.status, sort=query.sort,
                descending=query.descending, limit=query.limit, after=after, filters=query.filters,
            )
            if total is None:
                total = transaction.songs.count(
                    search=query.search, status=query.status, filters=query.filters,
                )
        cursor = None
        if page.next_key is not None:
            value, song_id = page.next_key
            cursor = base64.urlsafe_b64encode(dumps({
                "value": value, "songId": song_id, "total": total, "query": signature,
            }).encode()).decode()
        return SongPage(page.items, cursor, total)


def _decode_search_cursor(
    cursor: str | None, signature: str, sort: str,
) -> tuple[tuple[SongSortValue, str] | None, int | None]:
    if cursor is None:
        return None, None
    try:
        data = loads_object(base64.b64decode(cursor, altchars=b"-_", validate=True).decode())
        value, song_id, total = data["value"], data["songId"], data["total"]
        if data["query"] != signature or not isinstance(song_id, str) or not song_id:
            raise ValueError("Cursor does not match this search")
        if type(total) is not int or total < 0:
            raise ValueError("Invalid cursor count")
        if sort in ("createdAt", "updatedAt"):
            value = datetime.fromisoformat(value)
        elif sort in ("duration", "bpm"):
            if type(value) not in (int, float) or not math.isfinite(value):
                raise ValueError("Invalid cursor number")
        elif not isinstance(value, str):
            raise ValueError("Invalid cursor text")
        return (value, song_id), total
    except (ValueError, TypeError, KeyError, UnicodeError) as exc:
        raise DomainError("InvalidCursor", "Pagination cursor is invalid for this search", 400) from exc


def _encode_cursor(offset: int) -> str:
    return base64.urlsafe_b64encode(str(offset).encode("ascii")).decode("ascii")


def _decode_cursor(cursor: str | None) -> int:
    if not cursor:
        return 0
    try:
        value = int(base64.b64decode(cursor, altchars=b"-_", validate=True))
    except ValueError as exc:
        raise DomainError("InvalidCursor", "Pagination cursor is invalid", 400) from exc
    if value < 0:
        raise DomainError("InvalidCursor", "Pagination cursor is invalid", 400)
    return value
