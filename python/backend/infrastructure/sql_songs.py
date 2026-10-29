from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

from sqlalchemy import Select, String, and_, asc, case, cast, delete, desc, func, or_, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from backend.infrastructure.sql_time import as_utc
from backend.infrastructure.orm import (
    AnalysisRow,
    HistoryRow,
    ProjectRevisionRow,
    RecordingRow,
    SongRow,
)
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
from backend.songs.ports import SongFilters, SongSearchPage, SongSortValue, SongSummary


def _conditions(
    search: str | None, status: SongStatus | None, filters: SongFilters | None
) -> list[ColumnElement[bool]]:
    conditions: list[ColumnElement[bool]] = []
    if search:
        text = normalize_search(search)
        columns = (
            SongRow.title_normalized,
            SongRow.artist_normalized,
            SongRow.original_filename_normalized,
        )
        conditions.append(or_(*(column.contains(text, autoescape=True) for column in columns)))
    if status:
        conditions.append(SongRow.status == status.value)
    if filters:
        if filters.statuses is not None:
            conditions.append(SongRow.status.in_([item.value for item in filters.statuses]))
        if filters.language:
            conditions.append(SongRow.language == filters.language.value)
        duration = func.coalesce(SongRow.duration, 0)
        durations = {
            "short": duration < 180,
            "medium": duration.between(180, 300),
            "long": duration > 300,
        }
        if filters.duration in durations:
            conditions.append(durations[filters.duration])
        has_artwork = or_(
            func.coalesce(SongRow.cover_path, "") != "",
            func.coalesce(SongRow.artwork_url, "") != "",
        )
        artwork = {"with": has_artwork, "without": ~has_artwork}
        if filters.artwork in artwork:
            conditions.append(artwork[filters.artwork])
    return conditions


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
        original_filename=row.original_filename,
        detected_bpm=row.detected_bpm,
        detected_key=row.detected_key,
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
    row.original_filename = song.original_filename
    row.original_filename_normalized = normalize_search(song.original_filename or "")
    row.duration = song.duration
    row.media_format = song.media_format
    row.embedded_lyrics = song.embedded_lyrics
    row.language = song.language.value
    row.cover_state = song.cover_state.value
    row.cover_path = str(song.cover_path) if song.cover_path else None
    row.metadata_provenance_json = dumps(song.metadata_provenance)
    row.user_overrides_json = dumps({key: True for key in song.user_overrides})
    row.detected_bpm = song.detected_bpm
    row.detected_key = song.detected_key
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
        for model in (AnalysisRow, RecordingRow, ProjectRevisionRow):
            self._session.execute(delete(model).where(model.song_id == song_id))
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
        filters: SongFilters | None = None,
    ) -> Sequence[Song]:
        last_played = (
            select(func.max(HistoryRow.created_at))
            .where(HistoryRow.event_type == "SongPlayed", HistoryRow.entity_id == SongRow.song_id)
            .correlate(SongRow)
            .scalar_subquery()
        )
        columns = {
            "title": SongRow.title_normalized,
            "artist": SongRow.artist_normalized,
            "createdAt": SongRow.created_at,
            "updatedAt": SongRow.updated_at,
            "status": SongRow.status,
            "duration": func.coalesce(SongRow.duration, 0),
            "bpm": func.coalesce(SongRow.detected_bpm, -1),
            "played": last_played,
        }
        column = columns.get(sort, SongRow.title_normalized)
        order = desc(column) if descending else asc(column)
        query = select(SongRow).where(*_conditions(search, status, filters))
        query = query.order_by(order, asc(SongRow.song_id)).limit(limit).offset(offset)
        return [_to_domain(row) for row in self._session.scalars(query).all()]

    def count(
        self, *, search: str | None, status: SongStatus | None, filters: SongFilters | None = None
    ) -> int:
        query = (
            select(func.count()).select_from(SongRow).where(*_conditions(search, status, filters))
        )
        return int(self._session.scalar(query) or 0)

    def search(
        self, *, search: str | None, status: SongStatus | None, sort: str,
        descending: bool, limit: int, after: tuple[SongSortValue, str] | None,
        filters: SongFilters | None = None,
    ) -> SongSearchPage:
        played = (
            select(HistoryRow.entity_id.label("song_id"),
                   func.max(HistoryRow.created_at).label("last_played"))
            .where(HistoryRow.event_type == "SongPlayed")
            .group_by(HistoryRow.entity_id).subquery()
        )
        columns = {
            "title": SongRow.title_normalized,
            "artist": SongRow.artist_normalized,
            "createdAt": SongRow.created_at,
            "updatedAt": SongRow.updated_at,
            "duration": func.coalesce(SongRow.duration, 0),
            "bpm": func.coalesce(SongRow.detected_bpm, -1),
            "played": func.coalesce(cast(played.c.last_played, String), ""),
        }
        column = columns[sort]
        query: Select[tuple[SongRow, SongSortValue]] = select(SongRow, column.label("sort_value"))
        if sort == "played":
            query = query.outerjoin(played, played.c.song_id == SongRow.song_id)
        query = query.where(*_conditions(search, status, filters))
        if after is not None:
            value, song_id = after
            comparison = column < value if descending else column > value
            query = query.where(or_(comparison, and_(column == value, SongRow.song_id > song_id)))
        query = query.order_by(desc(column) if descending else asc(column), SongRow.song_id)
        rows = self._session.execute(query.limit(limit + 1)).all()
        visible = rows[:limit]
        next_key = (visible[-1][1], visible[-1][0].song_id) if len(rows) > limit else None
        return SongSearchPage([_to_domain(row[0]) for row in visible], next_key)

    def summary(self) -> SongSummary:
        total, ready = self._session.execute(
            select(
                func.count(SongRow.id),
                func.coalesce(
                    func.sum(case((SongRow.status == SongStatus.READY.value, 1), else_=0)), 0
                ),
            )
        ).one()
        languages = self._session.scalars(
            select(SongRow.language).distinct().order_by(SongRow.language)
        )
        return SongSummary(total, ready, [Language(value) for value in languages])
