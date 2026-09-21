from __future__ import annotations

from dataclasses import replace

from backend.domain_errors import ConflictError
from backend.runtime import Clock
from backend.persistence import UnitOfWorkFactory
from backend.processing.domain import Job, JobState, JobType
from backend.processing.job_manager import ProcessingJobManager
from backend.songs.domain import SongStatus


class CancelProcessing:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        jobs: ProcessingJobManager,
        clock: Clock,
    ) -> None:
        self._uow = uow
        self._jobs = jobs
        self._clock = clock

    def execute(self, job_id: str) -> Job:
        job = self._jobs.get(job_id)
        if job.job_type is not JobType.SONG_PROCESSING:
            raise ConflictError("InvalidJobType", "Job is not a song processing job")
        updated = self._jobs.cancel(job_id)
        if job.entity_id:
            self._update_song(job.entity_id, updated.state)
        return updated

    def _update_song(self, song_id: str, state: JobState) -> None:
        if state not in {JobState.CANCELLING, JobState.CANCELLED}:
            return
        status = SongStatus.CANCELLING if state is JobState.CANCELLING else SongStatus.CANCELLED
        with self._uow.create() as transaction:
            song = transaction.songs.get(song_id)
            if song:
                transaction.songs.update(replace(song, status=status, updated_at=self._clock.now()))
                transaction.commit()
