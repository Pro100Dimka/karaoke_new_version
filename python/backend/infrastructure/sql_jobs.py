from __future__ import annotations

from collections.abc import Sequence

from typing import cast

from sqlalchemy import func, select, update
from sqlalchemy.engine import CursorResult
from sqlalchemy.orm import Session

from backend.infrastructure.sql_time import as_utc, optional_utc
from backend.infrastructure.orm import JobRow
from backend.serialization import dumps, loads_object
from backend.processing.domain import Job, JobState, JobType, ProcessingMode


def _mapping(raw: str | None) -> dict[str, object] | None:
    return dict(loads_object(raw)) if raw else None


def _to_domain(row: JobRow) -> Job:
    return Job(
        job_id=row.job_id,
        job_type=JobType(row.job_type),
        state=JobState(row.state),
        entity_id=row.entity_id,
        mode=ProcessingMode(row.mode) if row.mode else None,
        correlation_id=row.correlation_id,
        stage=row.stage,
        stage_progress=row.stage_progress,
        overall_progress=row.overall_progress,
        eta_seconds=row.eta_seconds,
        error=_mapping(row.error_json),
        report=_mapping(row.report_json),
        created_at=as_utc(row.created_at),
        started_at=optional_utc(row.started_at),
        updated_at=as_utc(row.updated_at),
        finished_at=optional_utc(row.finished_at),
    )


def _apply(row: JobRow, job: Job) -> None:
    row.job_type = job.job_type.value
    row.state = job.state.value
    row.entity_id = job.entity_id
    row.mode = job.mode.value if job.mode else None
    row.correlation_id = job.correlation_id
    row.stage = job.stage
    row.stage_progress = job.stage_progress
    row.overall_progress = job.overall_progress
    row.eta_seconds = job.eta_seconds
    row.error_json = dumps(job.error) if job.error else None
    row.report_json = dumps(job.report) if job.report else None
    row.created_at = job.created_at
    row.started_at = job.started_at
    row.updated_at = job.updated_at
    row.finished_at = job.finished_at


class SqlJobRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def get(self, job_id: str) -> Job | None:
        row = self._session.scalar(select(JobRow).where(JobRow.job_id == job_id))
        return _to_domain(row) if row else None

    def add(self, job: Job) -> None:
        row = JobRow(job_id=job.job_id)
        _apply(row, job)
        self._session.add(row)

    def update(self, job: Job) -> None:
        row = self._session.scalar(select(JobRow).where(JobRow.job_id == job.job_id))
        if row is None:
            raise KeyError(job.job_id)
        _apply(row, job)

    def list(self, *, limit: int, offset: int, job_type: JobType | None = None) -> Sequence[Job]:
        query = select(JobRow)
        if job_type:
            query = query.where(JobRow.job_type == job_type.value)
        query = query.order_by(JobRow.created_at.desc(), JobRow.job_id).limit(limit).offset(offset)
        return [_to_domain(row) for row in self._session.scalars(query).all()]

    def count(self, *, job_type: JobType | None = None) -> int:
        query = select(func.count()).select_from(JobRow)
        if job_type:
            query = query.where(JobRow.job_type == job_type.value)
        return int(self._session.scalar(query) or 0)

    def mark_running_interrupted(self) -> int:
        states = (JobState.RUNNING.value, JobState.CANCELLING.value)
        result = self._session.execute(
            update(JobRow).where(JobRow.state.in_(states)).values(state=JobState.INTERRUPTED.value)
        )
        return int(cast(CursorResult[tuple[()]], result).rowcount or 0)
