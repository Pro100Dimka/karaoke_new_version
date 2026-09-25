from pathlib import Path
import threading

import pytest

from backend.projects.operations import SongOperation, SongOperationRegistry
from backend.domain_errors import DependencyError
from backend.processing.resource_scheduler import ProcessingResourceScheduler
from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.helpers import import_song, wait_for_job


@pytest.mark.parametrize("suffix", ["", "/melody"])
def test_rejected_processing_request_does_not_release_another_owner(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, suffix: str
) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song_id = import_song(client, source)["songId"]
        path = f"/songs/{song_id}/processing"
        body = {"mode": "Fast", "onlineLyrics": False}
        started = client.post(path, json=body)
        assert wait_for_job(client, started.json()["jobId"])["state"] == "Succeeded"
        claim = SongOperationRegistry.claim
        owners = []

        def competing_claim(registry, identity, operation):
            # Another request acquired the song after the initial status read.
            claim(registry, identity, operation)
            owners.append(registry)
            claim(registry, identity, operation)

        monkeypatch.setattr(SongOperationRegistry, "claim", competing_claim)
        response = client.post(path + suffix, json=body)
        assert response.status_code == 409, response.text
        assert owners[0].active(song_id) is SongOperation.PROCESSING
        owners[0].release(song_id, SongOperation.PROCESSING)


@pytest.mark.parametrize("outcome", ["cancel", "unavailable", "unexpected"])
def test_processing_admission_always_settles_song_status(tmp_path, monkeypatch, outcome):
    source = tmp_path / "song.wav"
    write_wav(source)
    finished = threading.Event()
    release = SongOperationRegistry.release

    def failed_admission(*args, **kwargs):
        if outcome == "unexpected":
            raise RuntimeError("Resource probe failed")
        code = {"cancel": "ResourceBudgetExceeded", "unavailable": "MissingCuda"}[outcome]
        raise DependencyError(code, "Cannot admit this job")

    def observed_release(registry, identity, operation):
        release(registry, identity, operation)
        if operation is SongOperation.PROCESSING:
            finished.set()

    monkeypatch.setattr(ProcessingResourceScheduler, "claim", failed_admission)
    monkeypatch.setattr(SongOperationRegistry, "release", observed_release)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song_id = import_song(client, source)["songId"]
        started = client.post(
            f"/songs/{song_id}/processing", json={"mode": "Fast", "onlineLyrics": False}
        )
        job_id = started.json()["jobId"]
        if outcome == "cancel":
            assert client.post(f"/jobs/{job_id}/cancel").status_code == 200
        assert finished.wait(3), "Processing cleanup did not run"
        expected = "Cancelled" if outcome == "cancel" else "Failed"
        assert client.get(f"/jobs/{job_id}").json()["state"] == expected
        assert client.get(f"/songs/{song_id}").json()["status"] == expected
