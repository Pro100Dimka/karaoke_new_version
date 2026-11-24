from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from threading import Event

import pytest

from backend.analysis.domain import AnalysisState, ScoreSummary
from backend.domain_errors import DomainError
from backend.infrastructure.hashing import sha256_file
from backend.processing.domain import JobState
from tests.test_recording_analysis_admission import admission as admission


@pytest.mark.parametrize("live", [False, True], ids=["offline", "live-score"])
def test_analysis_submission_and_replay_do_not_read_audio_before_returning_a_job(
    admission, monkeypatch, live
):
    if live:
        admission.database.recordings.update(
            replace(
                admission.recording,
                session_metadata={
                    "karaokeNoteScore": {
                        "version": 3,
                        "pitchAccuracyPercent": 90,
                        "meanSemitoneDeviation": 0.2,
                        "rhythmAccuracyPercent": 93,
                        "noteStabilityPercent": 85,
                        "expectedPitchSeconds": 1,
                        "assessedPitchSeconds": 1,
                        "totalNotes": 2,
                        "hitNotes": 2,
                    }
                },
            )
        )
    hashed = []

    def observed_hash(path, *checkpoints):
        hashed.append(path)
        return sha256_file(path, *checkpoints)

    def score(result, _context):
        assert result.recording_identity == sha256_file(admission.source)
        return ScoreSummary(90, 0.2, 93, 85, (), ())

    monkeypatch.setattr(admission.analysis, "_hasher", observed_hash)
    if not live:
        monkeypatch.setattr(admission.analysis, "_score", score)
    job = admission.analysis.execute("take")
    replay = admission.analysis.execute("take")
    assert job.state is JobState.QUEUED and replay.job_id == job.job_id
    assert hashed == [], "Submitting an analysis must not read the whole recording"
    queued = admission.database.analyses.get(job.entity_id)
    assert queued.state is AnalysisState.QUEUED and queued.recording_identity == ""

    admission.executor.run(job.job_id)

    result = admission.database.analyses.get(job.entity_id)
    assert admission.jobs.get(job.job_id).state is JobState.SUCCEEDED
    assert result.state is AnalysisState.SUCCEEDED
    assert result.recording_identity == sha256_file(admission.source)
    assert result.pitch_accuracy_percent == 90
    assert hashed == [admission.source]


def test_queued_analysis_cancellation_never_hashes_the_recording(admission, monkeypatch):
    def unexpected_hash(*_args):
        pytest.fail("A cancelled queued analysis must not begin reading audio")

    monkeypatch.setattr(admission.analysis, "_hasher", unexpected_hash)
    job = admission.analysis.execute("take")
    assert admission.jobs.cancel(job.job_id).state is JobState.CANCELLED
    admission.executor.run(job.job_id)
    result = admission.database.analyses.get(job.entity_id)
    assert admission.jobs.get(job.job_id).state is JobState.CANCELLED
    assert result.state is AnalysisState.FAILED
    assert result.error["code"] == "JobCancelled"
    assert result.recording_identity == ""
    idle = []
    admission.jobs.run_when_idle(lambda: idle.append(True))
    assert idle == [True] and not admission.analysis._active


def test_hash_cancellation_stops_reads_without_blocking_other_analysis_submissions(
    admission, monkeypatch
):
    payload = b"recorded audio" * (4 * 1024 * 1024 // 14 + 1)
    admission.source.write_bytes(payload)
    admission.database.recordings.add(replace(admission.recording, recording_id="other-take"))
    entered, release = Event(), Event()
    reads, handles, leases = [], [], []
    open_path = Path.open

    @contextmanager
    def admit(*_args):
        leases.append("acquired")
        try:
            yield
        finally:
            leases.append("released")

    class HeldReader:
        def __init__(self, stream):
            self.stream = stream

        def __enter__(self):
            return self

        def __exit__(self, *args):
            self.stream.close()

        def read(self, size):
            chunk = self.stream.read(size)
            reads.append(len(chunk))
            if len(reads) == 1:
                entered.set()
                assert release.wait(3), "The cancellation request did not release the read"
            return chunk

    def observe_open(path, mode="r", *args, **kwargs):
        stream = open_path(path, mode, *args, **kwargs)
        if path == admission.source and mode == "rb":
            handles.append(stream)
            return HeldReader(stream)
        return stream

    monkeypatch.setattr(admission.analysis._pitch, "admit", admit)
    monkeypatch.setattr(
        admission.analysis, "_score", lambda *_args: ScoreSummary(90, 0.2, 93, 85, (), ())
    )
    with monkeypatch.context() as reads_patch, ThreadPoolExecutor(max_workers=2) as pool:
        reads_patch.setattr(Path, "open", observe_open)
        job = admission.analysis.execute("take")
        assert reads == [], "Admission read audio before returning the cancellable job"
        worker = pool.submit(admission.executor.run, job.job_id)
        try:
            assert entered.wait(3), "Background verification did not begin reading"
            replay = pool.submit(admission.analysis.execute, "take").result(timeout=3)
            other = pool.submit(admission.analysis.execute, "other-take").result(timeout=3)
            assert replay.job_id == job.job_id and replay.state is JobState.RUNNING
            assert other.state is JobState.QUEUED and other.job_id != job.job_id
            assert admission.jobs.cancel(job.job_id).state is JobState.CANCELLING
            assert leases == ["acquired"]
        finally:
            release.set()
        worker.result(timeout=3)
    result = admission.database.analyses.get(job.entity_id)
    assert admission.jobs.get(job.job_id).state is JobState.CANCELLED
    assert result.state is AnalysisState.FAILED and result.error["code"] == "JobCancelled"
    assert result.recording_identity == "" and result.pitch_accuracy_percent is None
    assert handles and all(stream.closed for stream in handles)
    assert leases == ["acquired", "released"]
    print(
        f"analysis_checksum_reads={len(reads)} bytes_read={sum(reads)} total_bytes={len(payload)}"
    )
    assert reads == [1024 * 1024], "Cancellation continued reading the rest of the recording"
    assert admission.source.read_bytes() == payload
    admission.jobs.cancel(other.job_id)
    admission.executor.run(other.job_id)
    idle = []
    admission.jobs.run_when_idle(lambda: idle.append(True))
    assert idle == [True]
    retry = admission.analysis.execute("take")
    admission.executor.run(retry.job_id)
    completed = admission.database.analyses.get(retry.entity_id)
    assert admission.jobs.get(retry.job_id).state is JobState.SUCCEEDED
    assert completed.recording_identity == sha256_file(admission.source)


def test_background_identity_failure_preserves_the_domain_error_and_releases_the_source(
    admission, monkeypatch
):
    error = DomainError("RecordingFileMissing", "Recording audio file is unavailable", 404)

    def fail_hash(*_args):
        raise error

    monkeypatch.setattr(admission.analysis, "_hasher", fail_hash)
    job = admission.analysis.execute("take")
    admission.executor.run(job.job_id)
    failed = admission.jobs.get(job.job_id)
    result = admission.database.analyses.get(job.entity_id)
    assert failed.state is JobState.FAILED and failed.error["code"] == error.code
    assert result.state is AnalysisState.FAILED and result.error["code"] == error.code
    assert result.recording_identity == ""
    idle = []
    admission.jobs.run_when_idle(lambda: idle.append(True))
    assert idle == [True] and admission.source.is_file()
