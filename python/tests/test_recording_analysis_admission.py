from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import replace
from datetime import UTC, datetime
from types import SimpleNamespace
import threading
from uuid import uuid4

import pytest
import soundfile as sf

from backend.analysis.domain import AnalysisState
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


class _Database:
    def __init__(self, recording):
        self.recordings = _Rows("recording_id")
        self.recordings.add(recording)
        self.songs = _Rows("song_id")
        self.songs.add(SimpleNamespace(song_id=recording.song_id))
        self.analyses = _Rows("analysis_id")
        self.jobs = _Rows("job_id")

    @contextmanager
    def create(self):
        yield SimpleNamespace(
            recordings=self.recordings,
            songs=self.songs,
            analyses=self.analyses,
            jobs=self.jobs,
            commit=lambda: None,
        )


class _QueuedExecutor:
    def __init__(self):
        self.work = {}
        self.rejection = None

    def submit(self, job_id, work):
        if self.rejection is not None:
            raise self.rejection
        self.work[job_id] = work

    def stats(self):
        return {"activeOrQueued": len(self.work)}

    def cancel(self, job_id):
        return job_id in self.work


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
        SimpleNamespace(),
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
def test_analysis_source_identity_is_reserved_until_job_submission(admission, pause_after_hash):
    entered, resume = threading.Event(), threading.Event()
    published = []

    def paused_hash(path):
        identity = sha256_file(path) if pause_after_hash else None
        entered.set()
        assert resume.wait(3), "The archival attempt did not release hashing"
        return identity if identity is not None else sha256_file(path)

    def publish():
        admission.database.recordings.update(
            replace(admission.recording, file_path=admission.replacement)
        )
        admission.source.unlink(missing_ok=True)
        published.append(True)

    admission.analysis._hasher = paused_hash
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(admission.analysis.execute, "take")
        try:
            assert entered.wait(3), "Analysis did not reach its input hash"
            for allowed in ((), (JobType.RECORDING_ANALYSIS,)):
                try:
                    admission.jobs.run_when_idle(publish, allow_job_types=allowed)
                except ConflictError:
                    pass
        finally:
            resume.set()
        job = pending.result(timeout=3)
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
    assert allowed == [True], "Queued ownership replaces, rather than leaks, the reservation"


@pytest.mark.parametrize("failure", ["hash", "submission"])
def test_failed_analysis_admission_releases_files_and_preserves_synchronous_error(
    admission,
    failure,
):
    if failure == "hash":
        error = OSError("Input hash cannot be read")

        def fail_hash(_path):
            raise error

        admission.analysis._hasher = fail_hash
    else:
        error = ConflictError("JobQueueFull", "The processing queue is full")
        admission.executor.rejection = error
    with pytest.raises(type(error)) as caught:
        admission.analysis.execute("take")
    assert caught.value is error
    idle = []
    admission.jobs.run_when_idle(lambda: idle.append(True))
    assert idle == [True] and admission.source.is_file()
    if failure == "hash":
        assert not admission.database.analyses.values
    else:
        assert [item.state for item in admission.database.analyses.values.values()] == [
            AnalysisState.FAILED
        ]
        assert [item.state for item in admission.database.jobs.values.values()] == [JobState.FAILED]
