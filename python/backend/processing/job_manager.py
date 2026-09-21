from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, replace
from typing import Callable, Sequence

from backend.domain_errors import ConflictError, DomainError, NotFoundError
from backend.runtime import Clock
from backend.events import EventPublisher
from backend.runtime import IdGenerator
from backend.persistence import UnitOfWorkFactory
from backend.processing.domain import Job, JobState, JobType, ProcessingMode
from backend.processing.ports import JobExecutor

logger = logging.getLogger(__name__)
JobWork = Callable[["JobContext"], dict[str, object] | None]


@dataclass(frozen=True, slots=True)
class JobContext:
    job_id: str
    cancel: threading.Event
    progress: Callable[[str, float, float], None]

    def ensure_not_cancelled(self) -> None:
        if self.cancel.is_set():
            raise ConflictError("JobCancelled", "Job cancellation was requested")


class ProcessingJobManager:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        executor: JobExecutor,
        clock: Clock,
        ids: IdGenerator,
        events: EventPublisher,
    ) -> None:
        self._uow = uow
        self._executor = executor
        self._clock = clock
        self._ids = ids
        self._events = events

    def start(
        self,
        job_type: JobType,
        work: JobWork,
        *,
        entity_id: str | None = None,
        mode: ProcessingMode | None = None,
        correlation_id: str | None = None,
        on_finally: Callable[[], None] | None = None,
        admit: Callable[[threading.Event], None] | None = None,
    ) -> Job:
        now = self._clock.now()
        job = Job(
            job_id=self._ids.new(),
            job_type=job_type,
            state=JobState.QUEUED,
            entity_id=entity_id,
            mode=mode,
            correlation_id=correlation_id,
            created_at=now,
            updated_at=now,
        )
        with self._uow.create() as transaction:
            transaction.jobs.add(job)
            transaction.commit()
        try:
            self._executor.submit(
                job.job_id,
                lambda cancel: self._run(job.job_id, work, cancel, on_finally, admit),
            )
        except DomainError as exc:
            self._fail(job.job_id, exc)
            raise
        self._publish(job)
        return job

    def get(self, job_id: str) -> Job:
        with self._uow.create() as transaction:
            job = transaction.jobs.get(job_id)
        if job is None:
            raise NotFoundError("JobNotFound", "Background job was not found", jobId=job_id)
        return job

    def list(self, *, limit: int, offset: int, job_type: JobType | None = None) -> Sequence[Job]:
        with self._uow.create() as transaction:
            return transaction.jobs.list(limit=limit, offset=offset, job_type=job_type)

    def cancel(self, job_id: str) -> Job:
        job = self.get(job_id)
        if job.terminal:
            return job
        if job.state is JobState.QUEUED:
            updated = job.transition(JobState.CANCELLED, self._clock.now())
        elif job.state is JobState.RUNNING:
            updated = job.transition(JobState.CANCELLING, self._clock.now())
        else:
            updated = job
        self._save(updated)
        self._executor.cancel(job_id)
        self._publish(updated)
        return updated

    def recover_interrupted(self) -> int:
        with self._uow.create() as transaction:
            count = transaction.jobs.mark_running_interrupted()
            transaction.commit()
        return count

    def _run(
        self,
        job_id: str,
        work: JobWork,
        cancel: threading.Event,
        on_finally: Callable[[], None] | None,
        admit: Callable[[threading.Event], None] | None,
    ) -> None:
        try:
            if admit is not None:
                # The job stays Queued while it waits for resources; a cancel during the wait ends the wait.
                admit(cancel)
            self._execute(job_id, work, cancel)
        except DomainError as exc:
            self._fail(job_id, exc)
        finally:
            if on_finally:
                on_finally()

    def _execute(self, job_id: str, work: JobWork, cancel: threading.Event) -> None:
        job = self.get(job_id)
        if cancel.is_set() or job.state is JobState.CANCELLED:
            self._cancel_running(job_id)
            return
        running = job.transition(JobState.RUNNING, self._clock.now())
        self._save(running)
        self._publish(running)
        context = JobContext(
            job_id,
            cancel,
            lambda stage, part, total: self._progress(job_id, stage, part, total),
        )
        try:
            report = work(context)
            self._succeed_or_cancel(job_id, cancel, report)
        except DomainError as exc:
            if exc.code == "JobCancelled":
                self._cancel_running(job_id)
            else:
                self._fail(job_id, exc)
        except Exception:
            logger.exception("Unexpected background job error", extra={"jobId": job_id})
            self._fail(job_id, DomainError("InternalJobError", "Background job failed", 500))

    def _progress(
        self, job_id: str, stage: str, stage_progress: float, overall_progress: float
    ) -> None:
        job = self.get(job_id)
        updated = replace(
            job,
            stage=stage,
            stage_progress=max(0.0, min(1.0, stage_progress)),
            overall_progress=max(0.0, min(1.0, overall_progress)),
            updated_at=self._clock.now(),
        )
        self._save(updated)
        self._publish(updated)

    def _succeed_or_cancel(
        self,
        job_id: str,
        cancel: threading.Event,
        report: dict[str, object] | None,
    ) -> None:
        job = self.get(job_id)
        if cancel.is_set() or job.state is JobState.CANCELLING:
            self._cancel_running(job_id)
            return
        updated = replace(job, report=report, overall_progress=1.0)
        updated = updated.transition(JobState.SUCCEEDED, self._clock.now())
        self._save(updated)
        self._publish(updated)

    def _cancel_running(self, job_id: str) -> None:
        job = self.get(job_id)
        if job.state is JobState.RUNNING:
            job = job.transition(JobState.CANCELLING, self._clock.now())
        if job.state is JobState.CANCELLING:
            job = job.transition(JobState.CANCELLED, self._clock.now())
        if job.state is JobState.QUEUED:
            job = job.transition(JobState.CANCELLED, self._clock.now())
        self._save(job)
        self._publish(job)

    def _fail(self, job_id: str, error: DomainError) -> None:
        job = self.get(job_id)
        if job.state is JobState.QUEUED:
            job = job.transition(JobState.RUNNING, self._clock.now())
        failed = replace(
            job,
            error={"code": error.code, "message": error.message, "details": dict(error.details)},
        )
        if failed.state in {JobState.RUNNING, JobState.CANCELLING}:
            failed = failed.transition(JobState.FAILED, self._clock.now())
        self._save(failed)
        self._publish(failed)

    def _save(self, job: Job) -> None:
        with self._uow.create() as transaction:
            transaction.jobs.update(job)
            transaction.commit()

    def _publish(self, job: Job) -> None:
        self._events.publish(
            "job.changed",
            {
                "jobId": job.job_id,
                "type": job.job_type.value,
                "state": job.state.value,
                "stage": job.stage,
                "stageProgress": job.stage_progress,
                "overallProgress": job.overall_progress,
            },
        )
