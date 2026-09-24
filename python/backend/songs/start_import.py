from __future__ import annotations

from backend.processing.domain import Job, JobType
from backend.processing.job_manager import JobContext, ProcessingJobManager
from backend.songs.import_song import ImportSong, ImportSongRequest


class StartSongImport:
    def __init__(self, jobs: ProcessingJobManager, importer: ImportSong) -> None:
        self._jobs = jobs
        self._importer = importer

    def execute(self, request: ImportSongRequest) -> Job:
        return self._jobs.start(
            JobType.SONG_IMPORT,
            lambda context: self._run(request, context),
        )

    def _run(self, request: ImportSongRequest, context: JobContext) -> dict[str, object]:
        song = self._importer.execute(
            request,
            lambda stage, value: context.progress(stage, value, value),
            context.ensure_not_cancelled,
        )
        return {"songId": song.song_id}
