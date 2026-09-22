from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

from sqlalchemy import asc, desc, func, or_, select
from sqlalchemy.orm import Session

from backend.infrastructure.sql_time import as_utc
from backend.infrastructure.orm import SongRow
from backend.serialization import dumps, loads_object
from backend.text_normalization import normalize_search
from backend.songs.domain import (
    CoverState,
    Language,
    MetadataSource,
    Song,
    SongStatus,
    SourceState,
)


def _to_domain(row: SongRow) -> Song:
    provenance_raw = loads_object(row.metadata_provenance_json)
    provenance = {key: MetadataSource(str(value)) for key, value in provenance_raw.items()}
    overrides_raw = loads_object(row.user_overrides_json)
    overrides = frozenset(key for key, value in overrides_raw.items() if value is True)
    return Song(
        song_id=row.song_id,
        title=row.title,
        artist=row.artist,
        album=row.album,
        genre=row.genre,
        artwork_url=row.artwork_url,
        video_url=row.video_url,
        recognition_provider=row.recognition_provider,
        recognition_external_id=row.recognition_external_id,
        source_identity=row.source_identity,
        source_state=SourceState(row.source_state),
        source_path=Path(row.source_path) if row.source_path else None,
        duration=row.duration,
        media_format=row.media_format,
        embedded_lyrics=row.embedded_lyrics,
        language=Language(row.language),
        cover_state=CoverState(row.cover_state),
        cover_path=Path(row.cover_path) if row.cover_path else None,
        status=SongStatus(row.status),
        active_revision=row.active_revision,
        project_format_version=row.project_format_version,
        metadata_provenance=provenance,
        user_overrides=overrides,
        created_at=as_utc(row.created_at),
        updated_at=as_utc(row.updated_at),
    )


def _apply(row: SongRow, song: Song) -> None:
    row.title = song.title
    row.title_normalized = normalize_search(song.title)
    row.artist = song.artist
    row.artist_normalized = normalize_search(song.artist)
    row.album = song.album
    row.genre = song.genre
    row.artwork_url = song.artwork_url
    row.video_url = song.video_url
    row.recognition_provider = song.recognition_provider
    row.recognition_external_id = song.recognition_external_id
    row.source_identity = song.source_identity
    row.source_state = song.source_state.value
    row.source_path = str(song.source_path) if song.source_path else None
    row.duration = song.duration
    row.media_format = song.media_format
    row.embedded_lyrics = song.embedded_lyrics
    row.language = song.language.value
    row.cover_state = song.cover_state.value
    row.cover_path = str(song.cover_path) if song.cover_path else None
    row.metadata_provenance_json = dumps(song.metadata_provenance)
    row.user_overrides_json = dumps({key: True for key in song.user_overrides})
    row.status = song.status.value
    row.active_revision = song.active_revision
    row.project_format_version = song.project_format_version
    row.created_at = song.created_at
    row.updated_at = song.updated_at


class SqlSongRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def get(self, song_id: str) -> Song | None:
        row = self._session.scalar(select(SongRow).where(SongRow.song_id == song_id))
        return _to_domain(row) if row else None

    def get_by_source_identity(self, identity: str) -> Song | None:
        row = self._session.scalar(select(SongRow).where(SongRow.source_identity == identity))
        return _to_domain(row) if row else None

    def add(self, song: Song) -> None:
        row = SongRow(song_id=song.song_id)
        _apply(row, song)
        self._session.add(row)

    def update(self, song: Song) -> None:
        row = self._session.scalar(select(SongRow).where(SongRow.song_id == song.song_id))
        if row is None:
            raise KeyError(song.song_id)
        _apply(row, song)

    def delete(self, song_id: str) -> None:
        row = self._session.scalar(select(SongRow).where(SongRow.song_id == song_id))
        if row:
            self._session.delete(row)

    def list(
        self,
        *,
        search: str | None,
        status: SongStatus | None,
        sort: str,
        descending: bool,
        limit: int,
        offset: int,
    ) -> Sequence[Song]:
        columns = {
            "title": SongRow.title_normalized,
            "artist": SongRow.artist_normalized,
            "createdAt": SongRow.created_at,
            "updatedAt": SongRow.updated_at,
            "status": SongRow.status,
        }
        column = columns.get(sort, SongRow.title_normalized)
        order = desc(column) if descending else asc(column)
        query = select(SongRow)
        if search:
            pattern = f"%{normalize_search(search)}%"
            query = query.where(
                or_(SongRow.title_normalized.like(pattern), SongRow.artist_normalized.like(pattern))
            )
        if status:
            query = query.where(SongRow.status == status.value)
        query = query.order_by(order, asc(SongRow.song_id)).limit(limit).offset(offset)
        return [_to_domain(row) for row in self._session.scalars(query).all()]

    def count(self, *, search: str | None, status: SongStatus | None) -> int:
        query = select(func.count()).select_from(SongRow)
        if search:
            pattern = f"%{normalize_search(search)}%"
            query = query.where(
                or_(SongRow.title_normalized.like(pattern), SongRow.artist_normalized.like(pattern))
            )
        if status:
            query = query.where(SongRow.status == status.value)
        return int(self._session.scalar(query) or 0)
