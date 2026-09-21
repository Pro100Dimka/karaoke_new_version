from __future__ import annotations

from dataclasses import replace

from backend.analysis.domain import AnalysisResult, AnalysisState
from backend.analysis.ports import RecordingPitchExtractor
from backend.analysis.scoring import score_pitch
from backend.recordings.domain import Recording
from backend.domain_errors import DomainError, NotFoundError
from backend.history.domain import HistoryEvent
from backend.lyrics.codec import decode_document
from backend.persistence import UnitOfWorkFactory
from backend.processing.domain import Job, JobType
from backend.processing.job_manager import JobContext, ProcessingJobManager
from backend.projects.ports import ProjectStorage
from backend.runtime import Clock, IdGenerator
from backend.songs.ports import FileHasher
from backend.version import ANALYSIS_ALGORITHM_VERSION


class StartRecordingAnalysis:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        jobs: ProcessingJobManager,
        projects: ProjectStorage,
        pitch: RecordingPitchExtractor,
        hasher: FileHasher,
        clock: Clock,
        ids: IdGenerator,
    ) -> None:
        self._uow = uow
        self._jobs = jobs
        self._projects = projects
        self._pitch = pitch
        self._hasher = hasher
        self._clock = clock
        self._ids = ids

    def execute(self, recording_id: str) -> Job:
        recording, song_id, revision = self._inputs(recording_id)
        result = self._create_result(
            recording_id, song_id, revision, self._hasher.hash_file(recording.file_path)
        )
        return self._jobs.start(
            JobType.RECORDING_ANALYSIS,
            lambda context: self._run(result.analysis_id, context),
            entity_id=result.analysis_id,
        )

    def _run(self, analysis_id: str, context: JobContext) -> dict[str, object]:
        result = self._get(analysis_id)
        running = replace(result, state=AnalysisState.RUNNING, updated_at=self._clock.now())
        self._save(running)
        try:
            recording = self._recording(running.recording_id)
            reference = decode_document(
                self._projects.read_text_artifact(
                    running.song_id, running.song_revision, "lyricsSync"
                )
            )
            context.progress("PitchAnalysis", 0.0, 0.2)
            actual = self._pitch.extract(recording.file_path)
            context.progress("Scoring", 0.5, 0.7)
            score = score_pitch(reference, actual)
            done = replace(
                running,
                state=AnalysisState.SUCCEEDED,
                pitch_accuracy_percent=score.pitch_accuracy_percent,
                mean_semitone_deviation=score.mean_semitone_deviation,
                section_results=score.sections,
                problem_regions=score.problem_regions,
                updated_at=self._clock.now(),
            )
            self._save(done)
            self._record_history(done)
            return {"analysisId": analysis_id, "state": done.state.value}
        except DomainError as exc:
            failed = replace(
                running,
                state=AnalysisState.FAILED,
                error={"code": exc.code, "message": exc.message},
                updated_at=self._clock.now(),
            )
            self._save(failed)
            raise

    def _inputs(self, recording_id: str) -> tuple[Recording, str, int]:
        recording = self._recording(recording_id)
        if recording.song_id is None or recording.song_revision is None:
            raise DomainError(
                "AnalysisFailed", "Recording is not associated with a song revision", 409
            )
        with self._uow.create() as transaction:
            song = transaction.songs.get(recording.song_id)
        if song is None:
            raise NotFoundError("SongNotFound", "Recording song was not found")
        return recording, recording.song_id, recording.song_revision

    def _create_result(
        self, recording_id: str, song_id: str, revision: int, identity: str
    ) -> AnalysisResult:
        now = self._clock.now()
        result = AnalysisResult(
            self._ids.new(),
            recording_id,
            song_id,
            revision,
            str(ANALYSIS_ALGORITHM_VERSION),
            AnalysisState.QUEUED,
            now,
            now,
            identity,
        )
        with self._uow.create() as transaction:
            transaction.analyses.add(result)
            transaction.commit()
        return result

    def _recording(self, recording_id: str) -> Recording:
        with self._uow.create() as transaction:
            recording = transaction.recordings.get(recording_id)
        if recording is None:
            raise NotFoundError("RecordingNotFound", "Recording was not found")
        return recording

    def _get(self, analysis_id: str) -> AnalysisResult:
        with self._uow.create() as transaction:
            result = transaction.analyses.get(analysis_id)
        if result is None:
            raise NotFoundError("AnalysisNotFound", "Analysis result was not found")
        return result

    def _save(self, result: AnalysisResult) -> None:
        with self._uow.create() as transaction:
            transaction.analyses.update(result)
            transaction.commit()

    def _record_history(self, result: AnalysisResult) -> None:
        with self._uow.create() as transaction:
            transaction.history.add(
                HistoryEvent(
                    self._ids.new(),
                    "AnalysisCompleted",
                    self._clock.now(),
                    "Recording",
                    result.recording_id,
                )
            )
            transaction.commit()
