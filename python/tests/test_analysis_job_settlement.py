from __future__ import annotations

from contextlib import contextmanager, nullcontext
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Event
from types import SimpleNamespace

import pytest

from backend.ai.domain import RequiredModel
from backend.analysis.domain import AnalysisResult, AnalysisState, ScoreSummary
from backend.analysis.job_results import settled_analysis
from backend.domain_errors import ConflictError
from backend.infrastructure.hashing import sha256_file
from backend.infrastructure.recording_archive import RecordingArchive
from backend.processing.domain import Job, JobState, JobType
from backend.version import ANALYSIS_ALGORITHM_VERSION
from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.helpers import import_song, wait_for_job

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def no_background_audio_encoding(monkeypatch):
    monkeypatch.setattr(RecordingArchive, "_step", lambda archive: archive._cancel.wait(0.05))


def _take(client, tmp_path):
    reference = tmp_path / "reference.wav"
    write_wav(reference, seconds=0.125)
    song = import_song(client, reference)
    target = client.post("/recordings/target").json()
    path = Path(target["filePath"])
    write_wav(path, seconds=0.125)
    response = client.post(
        "/recordings",
        json={
            **target,
            "duration": 0.125,
            "sampleRate": 16000,
            "channels": 1,
            "createdAt": datetime.now(UTC).isoformat(),
            "songId": song["songId"],
            "songRevision": song["activeRevision"],
        },
    )
    assert response.status_code == 201, response.text
    return response.json(), path


def _wait_for_settlement(service, monkeypatch):
    finished = Event()
    settle = service._settle

    def complete(*args):
        try:
            return settle(*args)
        finally:
            finished.set()

    monkeypatch.setattr(service, "_settle", complete)
    return finished


def test_admission_failure_keeps_the_actual_error_in_analysis_history(tmp_path, monkeypatch):
    provider = FakeAiProvider(
        required_models=(RequiredModel("uninstalled-fixture", "1", "0" * 64),)
    )

    def no_ai(*_args, **_kwargs):
        pytest.fail("A rejected admission must not start audio processing")

    monkeypatch.setattr(provider, "separate", no_ai)
    monkeypatch.setattr(provider, "pitch", no_ai)
    with app_client(tmp_path / "runtime", ai_providers=(provider,)) as client:
        take, audio = _take(client, tmp_path)
        original = audio.read_bytes()
        service = client.app.state.container.recordings.start_analysis
        settled = _wait_for_settlement(service, monkeypatch)
        response = client.post(f"/recordings/{take['recordingId']}/analysis")
        assert response.status_code == 202, response.text
        job = wait_for_job(client, response.json()["jobId"])
        assert settled.wait(3), "Analysis did not settle after its admission failed"
        assert job["state"] == "Failed", job
        assert job["error"]["code"] == "MissingRequiredModels"
        result = client.get(f"/recordings/{take['recordingId']}/analyses").json()[0]
        assert result["state"] == "Failed"
        assert result["error"]["code"] == job["error"]["code"]
        assert result["error"]["message"] == job["error"]["message"]
        assert result["pitchAccuracyPercent"] is None
        assert audio.read_bytes() == original


@pytest.mark.parametrize(
    "state",
    [JobState.QUEUED, JobState.RUNNING, JobState.CANCELLING, None],
    ids=["Queued", "Running", "Cancelling", "orphan"],
)
def test_startup_settles_interrupted_analysis_without_losing_history_or_retry(
    tmp_path, monkeypatch, state
):
    root = tmp_path / "runtime"
    with app_client(root) as client:
        take, audio = _take(client, tmp_path)
        identity = take["recordingId"]
        original = audio.read_bytes()
        container = client.app.state.container
        # The real request persists the job and analysis. No executor runs after this crash boundary.
        if state is None:

            def crash_before_submission(*_args, **_kwargs):
                raise SystemExit("Crash after creating analysis but before its job")

            monkeypatch.setattr(container.system.jobs, "start", crash_before_submission)
            with pytest.raises(SystemExit):
                container.recordings.start_analysis.execute(identity)
            job_id = None
        else:
            monkeypatch.setattr(container.executor, "submit", lambda *_args: None)
            response = client.post(f"/recordings/{identity}/analysis")
            assert response.status_code == 202, response.text
            job_id = response.json()["jobId"]
        now = datetime.now(UTC)
        with container.database.create() as transaction:
            pending = transaction.analyses.list_for_recording(identity)[0]
            if state not in {None, JobState.QUEUED}:
                job = transaction.jobs.get(job_id)
                job = job.transition(JobState.RUNNING, now)
                if state is JobState.CANCELLING:
                    job = job.transition(JobState.CANCELLING, now)
                transaction.jobs.update(job)
                transaction.analyses.update(replace(pending, state=AnalysisState.RUNNING))
            earlier = AnalysisResult(
                "previous-success",
                identity,
                take["songId"],
                take["songRevision"],
                ANALYSIS_ALGORITHM_VERSION,
                AnalysisState.SUCCEEDED,
                now - timedelta(days=1),
                now - timedelta(days=1),
                sha256_file(audio),
                87,
                0.3,
                91,
                82,
            )
            transaction.analyses.add(earlier)
            earlier_failure = replace(
                earlier,
                analysis_id="previous-failure",
                state=AnalysisState.FAILED,
                error={"code": "PriorAnalysisFailure", "message": "Prior failure"},
            )
            transaction.analyses.add(earlier_failure)
            transaction.commit()

    with app_client(root) as client:
        if job_id is not None:
            assert client.get(f"/jobs/{job_id}").json()["state"] == "Interrupted"
        current = client.get(f"/recordings/{identity}").json()
        assert current["analysisStatus"] == "Failed", current
        results = client.get(f"/recordings/{identity}/analyses").json()
        interrupted = next(item for item in results if item["analysisId"] == pending.analysis_id)
        assert interrupted["state"] == "Failed"
        assert interrupted["error"]["code"] == "JobInterrupted"
        with client.app.state.container.database.create() as transaction:
            assert transaction.analyses.get(earlier.analysis_id) == earlier
            assert transaction.analyses.get(earlier_failure.analysis_id) == earlier_failure
        assert audio.read_bytes() == original

        service = client.app.state.container.recordings.start_analysis
        service._pitch = SimpleNamespace(admit=lambda *_args: nullcontext())
        monkeypatch.setattr(service, "_score", lambda *_args: ScoreSummary(90, 0.2, 93, 85, (), ()))
        settled = _wait_for_settlement(service, monkeypatch)
        retried = client.post(f"/recordings/{identity}/analysis")
        assert retried.status_code == 202, retried.text
        completed = wait_for_job(client, retried.json()["jobId"])
        assert settled.wait(3), "Retry did not finish settling"
        assert completed["state"] == "Succeeded", completed
        assert completed["jobId"] != job_id
        results = client.get(f"/recordings/{identity}/analyses").json()
        assert len(results) == 4
        assert sum(item["state"] == "Succeeded" for item in results) == 2
        assert audio.read_bytes() == original


def test_actual_cancellation_while_waiting_for_admission_stays_cancelled(tmp_path, monkeypatch):
    waiting = Event()

    @contextmanager
    def admit(_path, cancel):
        waiting.set()
        assert cancel.wait(3), "The waiting analysis was not cancelled"
        raise ConflictError("JobCancelled", "Recording analysis was cancelled")
        yield

    with app_client(tmp_path / "runtime") as client:
        take, audio = _take(client, tmp_path)
        original = audio.read_bytes()
        service = client.app.state.container.recordings.start_analysis
        service._pitch = SimpleNamespace(admit=admit)
        settled = _wait_for_settlement(service, monkeypatch)
        response = client.post(f"/recordings/{take['recordingId']}/analysis")
        assert response.status_code == 202, response.text
        job_id = response.json()["jobId"]
        assert waiting.wait(3), "Analysis did not begin waiting for resources"
        cancelled = client.post(f"/jobs/{job_id}/cancel")
        assert cancelled.status_code == 200, cancelled.text
        assert settled.wait(3), "Cancelled analysis did not settle"
        assert wait_for_job(client, job_id)["state"] == "Cancelled"
        result = client.get(f"/recordings/{take['recordingId']}/analyses").json()[0]
        assert result["state"] == "Failed"
        assert result["error"]["code"] == "JobCancelled"
        assert result["pitchAccuracyPercent"] is None
        assert audio.read_bytes() == original


@pytest.mark.parametrize("case", ["missing", "queued", "running", "other-entity", "other-type"])
def test_settlement_does_not_interrupt_live_admission_or_apply_an_unrelated_job(case):
    now = datetime.now(UTC)
    result = AnalysisResult(
        "analysis",
        "recording",
        "song",
        1,
        ANALYSIS_ALGORITHM_VERSION,
        AnalysisState.QUEUED,
        now,
        now,
        "identity",
    )
    job = Job(
        "job",
        JobType.RECORDING_ANALYSIS,
        JobState.FAILED,
        now,
        now,
        entity_id=result.analysis_id,
    )
    if case == "missing":
        job = None
    elif case == "queued":
        job = replace(job, state=JobState.QUEUED)
    elif case == "running":
        job = replace(job, state=JobState.RUNNING)
    elif case == "other-entity":
        job = replace(job, entity_id="other-analysis")
    else:
        job = replace(job, job_type=JobType.SONG_PROCESSING)
    assert settled_analysis(result, job, now) is None
    if job is not None:
        assert settled_analysis(result, job, now, at_startup=True) is None
