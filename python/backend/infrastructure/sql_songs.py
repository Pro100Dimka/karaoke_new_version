from __future__ import annotations

import base64
import math
from collections.abc import Callable, Sequence
from contextlib import AbstractContextManager, nullcontext
from datetime import datetime
from pathlib import Path

from sqlalchemy import Select, and_, asc, delete, desc, func, or_, select
from sqlalchemy.orm import Session

from backend.infrastructure.sql_time import as_utc
from backend.domain_errors import DomainError
from backend.infrastructure.orm import (
    AnalysisRow,
    HistoryRow,
    ProjectRevisionRow,
    RecordingRow,
    SongRow,
)
from backend.serialization import dumps, loads_list, loads_object
from backend.songs.ports import SongPage, SongSearch, SongSummary
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
    def __init__(
        self,
        session: Session,
        revision: Callable[[bool], str] | None = None,
        lock: AbstractContextManager[object] | None = None,
    ) -> None:
        self._session = session
        self._revision = revision or (lambda played: "")
        self._lock = lock or nullcontext()
        self.changed: set[str] = set()
        self.deleted: set[str] = set()

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
        self.changed.add(song.song_id)

    def update(self, song: Song) -> None:
        row = self._session.scalar(select(SongRow).where(SongRow.song_id == song.song_id))
        if row is None:
            raise KeyError(song.song_id)
        _apply(row, song)
        self.changed.add(song.song_id)

    def delete(self, song_id: str) -> None:
        for model in (AnalysisRow, RecordingRow, ProjectRevisionRow):
            self._session.execute(delete(model).where(model.song_id == song_id))
        row = self._session.scalar(select(SongRow).where(SongRow.song_id == song_id))
        if row:
            self._session.delete(row)
            self.deleted.add(song_id)
            self.changed.discard(song_id)

    def summary(self) -> SongSummary:
        groups = self._session.execute(
            select(SongRow.language, SongRow.status, func.count()).group_by(
                SongRow.language, SongRow.status
            )
        ).all()
        return SongSummary(
            sum(count for _, _, count in groups),
            sum(count for _, status, count in groups if status == SongStatus.READY.value),
            sorted({Language(language) for language, _, _ in groups}),
        )

    def search(self, query: SongSearch) -> SongPage:
        with self._lock:
            return self._search(query)

    def _search(self, query: SongSearch) -> SongPage:
        revision = self._revision(query.sort == "played")
        signature = dumps(
            [
                query.search,
                query.status,
                query.sort,
                query.descending,
                query.language,
                query.duration,
                query.artwork,
            ]
        )
        played = (
            select(
                HistoryRow.entity_id.label("song_id"),
                func.max(HistoryRow.created_at).label("played_at"),
            )
            .where(HistoryRow.event_type == "SongPlayed")
            .group_by(HistoryRow.entity_id)
            .subquery()
        )
        column = {
            "title": SongRow.title_normalized,
            "artist": SongRow.artist_normalized,
            "createdAt": SongRow.created_at,
            "duration": func.coalesce(SongRow.duration, 0.0),
            "bpm": func.coalesce(SongRow.detected_bpm, 0.0),
            "played": func.coalesce(played.c.played_at, datetime(1970, 1, 1)),
        }[query.sort]
        statement: Select[tuple[SongRow, object]] = select(SongRow, column.label("sort_value"))
        if query.sort == "played":
            statement = statement.outerjoin(played, played.c.song_id == SongRow.song_id)
        conditions = []
        if query.search:
            conditions.append(
                or_(
                    *(
                        field.contains(normalize_search(query.search), autoescape=True)
                        for field in (
                            SongRow.title_normalized,
                            SongRow.artist_normalized,
                            SongRow.original_filename_normalized,
                        )
                    )
                )
            )
        statuses = {
            "ready": ["Ready"],
            "importing": [],
            "processing": ["Processing", "Cancelling"],
            "queued": ["Queued"],
            "not-processed": ["Imported", "Cancelled"],
            "failed": ["Failed", "SourceMissing"],
            "invalid": ["ProjectInvalid"],
        }
        if query.status != "all":
            conditions.append(SongRow.status.in_(statuses[query.status]))
        if query.language:
            conditions.append(SongRow.language == query.language.value)
        duration = {
            "short": SongRow.duration < 180,
            "medium": and_(SongRow.duration >= 180, SongRow.duration < 300),
            "long": SongRow.duration >= 300,
        }
        if query.duration != "all":
            conditions.append(duration[query.duration])
        artwork = or_(
            SongRow.cover_path.is_not(None),
            and_(SongRow.artwork_url.is_not(None), SongRow.artwork_url != ""),
        )
        if query.artwork != "all":
            conditions.append(artwork if query.artwork == "with" else ~artwork)
        statement = statement.where(*conditions)
        if query.cursor:
            try:
                saved_revision, saved_filters, value, song_id = loads_list(
                    base64.b64decode(query.cursor, altchars=b"-_", validate=True).decode("utf8")
                )
                if saved_filters != signature or not isinstance(song_id, str):
                    raise ValueError("Cursor does not match search")
                if saved_revision != revision:
                    raise DomainError(
                        "CatalogChanged", "The library changed; refresh the search", 409
                    )
                if query.sort in ("createdAt", "played"):
                    value = datetime.fromisoformat(value)
                elif query.sort in ("duration", "bpm"):
                    if not isinstance(value, (int, float)) or not math.isfinite(value):
                        raise ValueError("Invalid numeric cursor")
                elif not isinstance(value, str):
                    raise ValueError("Invalid text cursor")
            except (ValueError, TypeError, UnicodeError) as exc:
                raise DomainError("InvalidCursor", "Pagination cursor is invalid", 400) from exc
            after = column < value if query.descending else column > value
            statement = statement.where(
                or_(after, and_(column == value, SongRow.song_id > song_id))
            )
        rows = self._session.execute(
            statement.order_by(
                desc(column) if query.descending else asc(column), asc(SongRow.song_id)
            ).limit(query.limit + 1)
        ).all()
        page = rows[: query.limit]
        cursor = None
        if len(rows) > query.limit:
            song, value = page[-1]
            cursor = base64.urlsafe_b64encode(
                dumps(
                    [
                        revision,
                        signature,
                        value,
                        song.song_id,
                    ]
                ).encode("utf8")
            ).decode("ascii")
        return SongPage([_to_domain(row) for row, _ in page], cursor)

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
                or_(
                    SongRow.title_normalized.like(pattern),
                    SongRow.artist_normalized.like(pattern),
                    SongRow.original_filename_normalized.like(pattern),
                )
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
                or_(
                    SongRow.title_normalized.like(pattern),
                    SongRow.artist_normalized.like(pattern),
                    SongRow.original_filename_normalized.like(pattern),
                )
            )
        if status:
            query = query.where(SongRow.status == status.value)
        return int(self._session.scalar(query) or 0)
