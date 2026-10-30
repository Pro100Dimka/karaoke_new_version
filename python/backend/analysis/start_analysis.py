from __future__ import annotations

from dataclasses import replace
from contextlib import ExitStack
from collections.abc import Callable
import threading

from backend.analysis.domain import AnalysisResult, AnalysisState
from backend.analysis.ports import RecordingPitchExtractor
from backend.analysis.scoring import ScoreSummary, reference_audio_start, score_pitch
from backend.analysis.queries import live_result
from backend.recordings.domain import Recording
from backend.domain_errors import DomainError, NotFoundError
from backend.history.domain import HistoryEvent
from backend.lyrics.codec import decode_document
from backend.persistence import UnitOfWorkFactory
from backend.processing.domain import Job, JobState, JobType
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
        on_completed: Callable[[str], None] | None = None,
    ) -> None:
        self._uow = uow
        self._jobs = jobs
        self._projects = projects
        self._pitch = pitch
        self._hasher = hasher
        self._clock = clock
        self._ids = ids
        self._on_completed = on_completed
        self._submission_lock = threading.RLock()
        self._active: dict[str, Job] = {}

    def execute(self, recording_id: str) -> Job:
        with self._submission_lock:
            previous = self._active.get(recording_id)
            current = self._jobs.get(previous.job_id) if previous else None
            if current and current.state in {
                JobState.QUEUED,
                JobState.RUNNING,
                JobState.CANCELLING,
            }:
                return current
            job = self._start(recording_id)
            self._active[recording_id] = job
            return job

    def _start(self, recording_id: str) -> Job:
        recording, song_id, revision = self._inputs(recording_id)
        live = live_result(recording)
        result = self._create_result(
            recording_id, song_id, revision, self._hasher(recording.file_path)
        )
        admission = ExitStack()
        try:
            return self._jobs.start(
                JobType.RECORDING_ANALYSIS,
                lambda context: self._run(result.analysis_id, context),
                entity_id=result.analysis_id,
                on_finally=lambda: self._settle(recording_id, result.analysis_id, admission),
                admit=None
                if live is not None
                else lambda cancel: admission.enter_context(
                    self._pitch.admit(self._recording(recording_id).file_path, cancel)
                ),
            )
        except DomainError as exc:
            self._fail(result, exc.code, exc.message)
            raise

    def _settle(self, recording_id: str, analysis_id: str, admission: ExitStack) -> None:
        try:
            with self._submission_lock:
                current = self._active.get(recording_id)
                if current and current.entity_id == analysis_id:
                    self._active.pop(recording_id)
                self._cancel_queued(analysis_id)
        finally:
            admission.close()

    def _run(self, analysis_id: str, context: JobContext) -> dict[str, object]:
        result = self._get(analysis_id)
        running = replace(result, state=AnalysisState.RUNNING, updated_at=self._clock.now())
        self._save(running)
        settled = False
        try:
            context.ensure_not_cancelled()
            score = self._score(running, context)
            context.ensure_not_cancelled()
            done = self._succeeded(running, score)
            self._save(done)
            settled = True
            self._record_history(done)
            if self._on_completed:
                self._on_completed(done.recording_id)
            return {"analysisId": analysis_id, "state": done.state.value}
        except DomainError as exc:
            self._fail(running, exc.code, exc.message)
            settled = True
            raise
        finally:
            # Anything unexpected (out of memory, a broken file) still ends the analysis instead of
            # leaving it "running" for ever; the job manager logs and reports the error itself.
            if not settled:
                self._fail(running, "AnalysisFailed", "Recording analysis failed")

    def _cancel_queued(self, analysis_id: str) -> None:
        result = self._get(analysis_id)
        if result.state is AnalysisState.QUEUED:
            self._fail(result, "JobCancelled", "Recording analysis was cancelled before execution")

    def _fail(self, running: AnalysisResult, code: str, message: str) -> None:
        self._save(
            replace(
                running,
                state=AnalysisState.FAILED,
                error={"code": code, "message": message},
                updated_at=self._clock.now(),
            )
        )

    def _score(self, running: AnalysisResult, context: JobContext) -> ScoreSummary:
        """Measure both vocals with the same detector; UI polling is not analysis evidence."""
        recording = self._recording(running.recording_id)
        live = live_result(recording)
        if live is not None:
            if live.state is AnalysisState.FAILED:
                raise DomainError(
                    "AnalysisPitchUncertain", "Too little reliable microphone pitch evidence", 422
                )
            return ScoreSummary(
                live.pitch_accuracy_percent or 0.0,
                live.mean_semitone_deviation or 0.0,
                live.rhythm_accuracy_percent or 0.0,
                live.note_stability_percent or 0.0,
                (),
                (),
            )
        reference = decode_document(
            self._projects.read_text_artifact(running.song_id, running.song_revision, "lyricsSync")
        )
        reference_vocal = self._projects.artifact_path(
            running.song_id, running.song_revision, "referenceVocal"
        )
        metadata = recording.session_metadata or {}
        raw_adjustments = metadata.get("playbackAdjustments", ())
        adjustments = raw_adjustments if isinstance(raw_adjustments, (list, tuple)) else ()
        actual, expected = self._pitch.extract_vocals(
            recording.file_path,
            reference_vocal,
            context.cancel,
            context.progress,
            reference_start=reference_audio_start(adjustments),
        )
        context.progress("Scoring", 0.0, 0.95)
        return score_pitch(
            reference, actual, adjustments, recording.duration, reference_pitch=expected
        )

    def _succeeded(self, running: AnalysisResult, score: ScoreSummary) -> AnalysisResult:
        return replace(
            running,
            state=AnalysisState.SUCCEEDED,
            pitch_accuracy_percent=score.pitch_accuracy_percent,
            mean_semitone_deviation=score.mean_semitone_deviation,
            rhythm_accuracy_percent=score.rhythm_accuracy_percent,
            note_stability_percent=score.note_stability_percent,
            section_results=score.sections,
            problem_regions=score.problem_regions,
            updated_at=self._clock.now(),
        )

    def _inputs(self, recording_id: str) -> tuple[Recording, str, int]:
        recording = self._recording(recording_id)
        if recording.file_status in {"Preparing", "PreparationFailed"}:
            raise DomainError("RecordingPreparing", "Recording preparation is not complete", 409)
        if recording.file_status == "RecoveredIncomplete":
            raise DomainError("RecordingTimingUnavailable", "Interrupted recording has no verified timing", 409)
        if recording.song_id is None or recording.song_revision is None:
            raise DomainError(
                "AnalysisFailed", "Recording is not associated with a song revision", 409
            )
        with self._uow.create() as transaction:
            song = transaction.songs.get(recording.song_id)
        if song is None:
            raise NotFoundError("SongNotFound", "Recording song was not found")
        if not recording.file_path.is_file():
            # The take is listed but its audio is gone (deleted or moved outside the app).
            raise NotFoundError("RecordingFileMissing", "Recording audio file is missing")
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
