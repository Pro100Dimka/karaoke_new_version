from __future__ import annotations

import base64
from dataclasses import dataclass

from backend.domain_errors import DomainError, NotFoundError
from backend.persistence import UnitOfWorkFactory
from backend.songs.domain import Song, SongStatus
from backend.songs.ports import SongPage


@dataclass(frozen=True, slots=True)
class ListSongsQuery:
    search: str | None = None
    status: SongStatus | None = None
    sort: str = "title"
    descending: bool = False
    limit: int = 50
    cursor: str | None = None


class GetSong:
    def __init__(self, uow: UnitOfWorkFactory) -> None:
        self._uow = uow

    def execute(self, song_id: str) -> Song:
        with self._uow.create() as transaction:
            song = transaction.songs.get(song_id)
        if song is None:
            raise NotFoundError("SongNotFound", "Song was not found", songId=song_id)
        return song


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
            )
            total = transaction.songs.count(search=query.search, status=query.status)
        next_offset = offset + len(items)
        next_cursor = _encode_cursor(next_offset) if next_offset < total else None
        return SongPage(items, next_cursor)


def _encode_cursor(offset: int) -> str:
    return base64.urlsafe_b64encode(str(offset).encode("ascii")).decode("ascii")


def _decode_cursor(cursor: str | None) -> int:
    if not cursor:
        return 0
    try:
        raw = base64.urlsafe_b64decode(cursor.encode("ascii")).decode("ascii")
        value = int(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise DomainError("InvalidCursor", "Pagination cursor is invalid", 400) from exc
    if value < 0:
        raise DomainError("InvalidCursor", "Pagination cursor is invalid", 400)
    return value
