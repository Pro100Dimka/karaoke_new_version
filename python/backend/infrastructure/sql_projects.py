from __future__ import annotations

from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from backend.infrastructure.sql_time import as_utc
from backend.infrastructure.orm import ProjectRevisionRow
from backend.projects.domain import ProjectRevision


def _to_domain(row: ProjectRevisionRow) -> ProjectRevision:
    return ProjectRevision(
        song_id=row.song_id,
        revision=row.revision,
        fingerprint=row.fingerprint,
        project_format_version=row.project_format_version,
        lineage_id=row.lineage_id,
        created_at=as_utc(row.created_at),
    )


class SqlProjectRevisionRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def get(self, song_id: str, revision: int) -> ProjectRevision | None:
        row = self._session.scalar(
            select(ProjectRevisionRow).where(
                ProjectRevisionRow.song_id == song_id,
                ProjectRevisionRow.revision == revision,
            )
        )
        return _to_domain(row) if row else None

    def add(self, revision: ProjectRevision) -> None:
        self._session.add(
            ProjectRevisionRow(
                song_id=revision.song_id,
                revision=revision.revision,
                fingerprint=revision.fingerprint,
                project_format_version=revision.project_format_version,
                lineage_id=revision.lineage_id,
                created_at=revision.created_at,
            )
        )

    def latest(self, song_id: str) -> ProjectRevision | None:
        row = self._session.scalar(
            select(ProjectRevisionRow)
            .where(ProjectRevisionRow.song_id == song_id)
            .order_by(desc(ProjectRevisionRow.revision))
            .limit(1)
        )
        return _to_domain(row) if row else None
