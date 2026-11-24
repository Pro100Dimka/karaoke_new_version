from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager, nullcontext
from dataclasses import replace
from datetime import UTC, datetime
from types import SimpleNamespace
import threading
from uuid import uuid4

import pytest
import soundfile as sf

from backend.analysis.domain import AnalysisState, ScoreSummary
from backend.analysis.start_analysis import StartRecordingAnalysis
from backend.domain_errors import ConflictError
from backend.infrastructure.hashing import sha256_file
from backend.processing.domain import JobState, JobType
from backend.processing.job_manager import ProcessingJobManager
from backend.recordings.domain import Recording


class _Rows:
    def __init__(self, identity):
        self.identity = identity
        self.values = {}

    def get(self, identity):
        return self.values.get(identity)

    def add(self, value):
        self.values[getattr(value, self.identity)] = value

    def update(self, value):
        self.add(value)

    def list(self, *, limit, offset=0, job_type=None, entity_id=None):
        matches = [
            item
            for item in self.values.values()
            if (job_type is None or item.job_type is job_type)
            and (entity_id is None or item.entity_id == entity_id)
        ]
        return matches[offset : offset + limit]


class _Database:
    def __init__(self, recording):
        self.recordings = _Rows("recording_id")
        self.recordings.add(recording)
        self.songs = _Rows("song_id")
        self.songs.add(SimpleNamespace(song_id=recording.song_id))
        self.analyses = _Rows("analysis_id")
        self.jobs = _Rows("job_id")
        self.history = _Rows("event_id")

    @contextmanager
    def create(self):
        yield SimpleNamespace(
            recordings=self.recordings,
            songs=self.songs,
            analyses=self.analyses,
            jobs=self.jobs,
            history=self.history,
            commit=lambda: None,
        )


class _QueuedExecutor:
    def __init__(self):
        self.work = {}
        self.cancellations = {}
        self.rejection = None

    def submit(self, job_id, work, *, admit=None):
        if self.rejection is not None:
            raise self.rejection

        def execute(cancel):
            if admit is None or admit(cancel):
                work(cancel)

        self.work[job_id] = execute
        self.cancellations[job_id] = threading.Event()

    def run(self, job_id):
        try:
            self.work[job_id](self.cancellations[job_id])
        finally:
            self.work.pop(job_id)
            self.cancellations.pop(job_id)

    def stats(self):
        return {"activeOrQueued": len(self.work)}

    def cancel(self, job_id):
        if job_id not in self.work:
            return False
        self.cancellations[job_id].set()
        return True


@pytest.fixture
def admission(tmp_path):
    source, replacement = tmp_path / "recording.wav", tmp_path / "recording.flac"
    samples = [0.1, -0.1] * 1024
    for path in (source, replacement):
        sf.write(path, samples, 48000, subtype="PCM_16")
    recording = Recording(
        "take",
        source,
        len(samples) / 48000,
        48000,
        1,
        datetime.now(UTC),
        song_id="song",
        song_revision=1,
    )
    database = _Database(recording)
    executor = _QueuedExecutor()
    clock = SimpleNamespace(now=lambda: datetime.now(UTC))
    ids = SimpleNamespace(new=lambda: str(uuid4()))
    jobs = ProcessingJobManager(
        database,
        executor,
        clock,
        ids,
        SimpleNamespace(publish=lambda *_: None),
    )
    analysis = StartRecordingAnalysis(
        database,
        jobs,
        SimpleNamespace(),
        SimpleNamespace(admit=lambda *_args: nullcontext()),
        sha256_file,
        clock,
        ids,
    )
    return SimpleNamespace(
        source=source,
        replacement=replacement,
        recording=recording,
        database=database,
        executor=executor,
        jobs=jobs,
        analysis=analysis,
    )


@pytest.mark.parametrize("pause_after_hash", [False, True], ids=["before-open", "after-hash"])
def test_analysis_source_identity_is_reserved_during_background_hash(admission, pause_after_hash):
    entered, resume = threading.Event(), threading.Event()
    scoring, finish = threading.Event(), threading.Event()
    published = []

    def paused_hash(path, checkpoint):
        identity = sha256_file(path, checkpoint) if pause_after_hash else None
        entered.set()
        assert resume.wait(3), "The archival attempt did not release hashing"
        return identity if identity is not None else sha256_file(path, checkpoint)

    def paused_score(*_args):
        scoring.set()
        assert finish.wait(3), "Ownership checks did not release scoring"
        return ScoreSummary(90, 0.2, 93, 85, (), ())

    def publish():
        admission.database.recordings.update(
            replace(admission.recording, file_path=admission.replacement)
        )
        admission.source.unlink(missing_ok=True)
        published.append(True)

    admission.analysis._hasher = paused_hash
    admission.analysis._score = paused_score
    job = admission.analysis.execute("take")
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(admission.executor.run, job.job_id)
        try:
            assert entered.wait(3), "Analysis did not reach its input hash"
            for allowed in ((), (JobType.RECORDING_ANALYSIS,)):
                with pytest.raises(ConflictError):
                    admission.jobs.run_when_idle(publish, allow_job_types=allowed)
            resume.set()
            assert scoring.wait(3), "Analysis did not finish identifying its source"
            result = admission.database.analyses.get(job.entity_id)
            current = admission.database.recordings.get("take")
            assert result.recording_identity == sha256_file(current.file_path)
            assert not published and current.file_path == admission.source
            with pytest.raises(ConflictError):
                admission.jobs.run_when_idle(publish)
            allowed = []
            admission.jobs.run_when_idle(
                lambda: allowed.append(True), allow_job_types=(JobType.RECORDING_ANALYSIS,)
            )
            assert allowed == [True], "Job ownership replaces, rather than leaks, the reservation"
        finally:
            resume.set()
            finish.set()
        pending.result(timeout=3)
    assert admission.jobs.get(job.job_id).state is JobState.SUCCEEDED
    idle = []
    admission.jobs.run_when_idle(lambda: idle.append(True))
    assert idle == [True]


@pytest.mark.parametrize("failure", ["hash", "submission"])
def test_failed_analysis_hash_or_submission_releases_files(
    admission,
    failure,
):
    if failure == "hash":
        error = OSError("Input hash cannot be read")

        def fail_hash(_path, _checkpoint):
            raise error

        admission.analysis._hasher = fail_hash
    else:
        error = ConflictError("JobQueueFull", "The processing queue is full")
        admission.executor.rejection = error
    if failure == "hash":
        # Byte reads now belong to the cancellable job; lightweight admission errors stay sync.
        job = admission.analysis.execute("take")
        admission.executor.run(job.job_id)
        assert admission.jobs.get(job.job_id).error["code"] == "InternalJobError"
        assert admission.database.analyses.get(job.entity_id).error["code"] == "AnalysisFailed"
    else:
        with pytest.raises(type(error)) as caught:
            admission.analysis.execute("take")
        assert caught.value is error
    idle = []
    admission.jobs.run_when_idle(lambda: idle.append(True))
    assert idle == [True] and admission.source.is_file()
    assert [item.state for item in admission.database.analyses.values.values()] == [
        AnalysisState.FAILED
    ]
    assert [item.state for item in admission.database.jobs.values.values()] == [JobState.FAILED]
