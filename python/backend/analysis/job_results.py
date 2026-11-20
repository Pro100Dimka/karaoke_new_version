from __future__ import annotations

from collections.abc import Mapping
from dataclasses import replace
from datetime import datetime

from backend.analysis.domain import AnalysisResult, AnalysisState
from backend.persistence import UnitOfWorkFactory
from backend.processing.domain import Job, JobState, JobType
from backend.runtime import Clock


def settled_analysis(
    result: AnalysisResult, job: Job | None, now: datetime, *, at_startup: bool = False
) -> AnalysisResult | None:
    if result.state not in {AnalysisState.QUEUED, AnalysisState.RUNNING}:
        return None
    if job is None and not at_startup:
        return None  # The normal admission path may still be publishing its job.
    if job is not None and (
        job.job_type is not JobType.RECORDING_ANALYSIS or job.entity_id != result.analysis_id
    ):
        return None
    error = _terminal_error(job)
    if error is None:
        return None
    return replace(result, state=AnalysisState.FAILED, error=error, updated_at=now)


def _terminal_error(job: Job | None) -> Mapping[str, object] | None:
    if job is None or job.state is JobState.INTERRUPTED:
        return {
            "code": "JobInterrupted",
            "message": "Recording analysis was interrupted; start it again",
        }
    if job.state is JobState.CANCELLED:
        return {"code": "JobCancelled", "message": "Recording analysis was cancelled"}
    if job.state is JobState.FAILED:
        return (
            dict(job.error)
            if job.error
            else {"code": "AnalysisFailed", "message": "Recording analysis failed"}
        )
    return None


class ReconcileInterruptedAnalyses:
    def __init__(self, uow: UnitOfWorkFactory, clock: Clock) -> None:
        self._uow, self._clock = uow, clock

    def execute(self) -> int:
        repaired = 0
        with self._uow.create() as transaction:
            for result in transaction.analyses.list_unfinished():
                jobs = transaction.jobs.list(
                    limit=1,
                    offset=0,
                    job_type=JobType.RECORDING_ANALYSIS,
                    entity_id=result.analysis_id,
                )
                updated = settled_analysis(
                    result, jobs[0] if jobs else None, self._clock.now(), at_startup=True
                )
                if updated is not None:
                    transaction.analyses.update(updated)
                    repaired += 1
            transaction.commit()
        return repaired
