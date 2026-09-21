from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from backend.infrastructure.sql_time import as_utc
from backend.infrastructure.orm import RecordingRow
from backend.serialization import dumps, loads_list, loads_optional_object
from backend.recordings.domain import Recording


def _to_domain(row: RecordingRow) -> Recording:
    gaps_raw = loads_list(row.gaps_json)
    gaps = tuple(dict(item) for item in gaps_raw if isinstance(item, dict))
    session = loads_optional_object(row.session_json)
    return Recording(
        recording_id=row.recording_id,
        song_id=row.song_id,
        song_revision=row.song_revision,
        file_path=Path(row.file_path),
        duration=row.duration,
        sample_rate=row.sample_rate,
        channels=row.channels,
        created_at=as_utc(row.created_at),
        gaps=gaps,
        session_metadata=session,
    )


class SqlRecordingRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def get(self, recording_id: str) -> Recording | None:
        row = self._session.scalar(
            select(RecordingRow).where(RecordingRow.recording_id == recording_id)
        )
        return _to_domain(row) if row else None

    def add(self, recording: Recording) -> None:
        self._session.add(
            RecordingRow(
                recording_id=recording.recording_id,
                song_id=recording.song_id,
                song_revision=recording.song_revision,
                file_path=str(recording.file_path),
                duration=recording.duration,
                sample_rate=recording.sample_rate,
                channels=recording.channels,
                created_at=recording.created_at,
                gaps_json=dumps(recording.gaps),
                session_json=dumps(recording.session_metadata),
            )
        )

    def delete(self, recording_id: str) -> None:
        row = self._session.scalar(
            select(RecordingRow).where(RecordingRow.recording_id == recording_id)
        )
        if row:
            self._session.delete(row)

    def list(self, *, song_id: str | None, limit: int, offset: int) -> Sequence[Recording]:
        query = select(RecordingRow)
        if song_id:
            query = query.where(RecordingRow.song_id == song_id)
        query = query.order_by(RecordingRow.created_at.desc(), RecordingRow.recording_id)
        query = query.limit(limit).offset(offset)
        return [_to_domain(row) for row in self._session.scalars(query).all()]

    def count(self, *, song_id: str | None) -> int:
        query = select(func.count()).select_from(RecordingRow)
        if song_id:
            query = query.where(RecordingRow.song_id == song_id)
        return int(self._session.scalar(query) or 0)
