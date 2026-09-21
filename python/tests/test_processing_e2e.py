from __future__ import annotations

import pytest
from pathlib import Path

from backend.ai.domain import AiCapability, AiProviderDescriptor
from backend.domain_errors import DependencyError
from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.helpers import import_song, wait_for_job


pytestmark = [pytest.mark.integration, pytest.mark.e2e]


def test_full_processing_flow_publishes_ready_revision(tmp_path: Path) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)

    with next_client(tmp_path) as client:
        song = import_song(client, source)
        started = client.post(
            f"/songs/{song['songId']}/processing",
            json={"mode": "Fast", "onlineLyrics": False},
            headers={"Idempotency-Key": "process-once"},
        )
        assert started.status_code == 202, started.text
        job = wait_for_job(client, started.json()["jobId"])

        assert job["state"] == "Succeeded", job
        assert job["overallProgress"] == 1.0
        assert job["report"]["algorithmVersion"] == "pipeline-1"
        updated = client.get(f"/songs/{song['songId']}").json()
        assert updated["status"] == "Ready"
        assert updated["activeRevision"] == 2
        editor = client.get(f"/songs/{song['songId']}/editor")
        assert editor.status_code == 200, editor.text
        assert editor.json()["document"]["words"][0]["notes"]


def test_processing_idempotency_returns_same_job(tmp_path: Path) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)

    with next_client(tmp_path) as client:
        song = import_song(client, source)
        path = f"/songs/{song['songId']}/processing"
        headers = {"Idempotency-Key": "processing-key"}
        first = client.post(path, json={"mode": "Fast", "onlineLyrics": False}, headers=headers)
        second = client.post(path, json={"mode": "Fast", "onlineLyrics": False}, headers=headers)

        assert first.status_code == 202, first.text
        assert second.status_code == 202, second.text
        assert first.json()["jobId"] == second.json()["jobId"]
        assert wait_for_job(client, first.json()["jobId"])["state"] == "Succeeded"


def test_missing_ai_models_or_provider_is_rejected_before_heavy_processing(
    client, tmp_path: Path
) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    song = import_song(client, source)

    response = client.post(
        f"/songs/{song['songId']}/processing",
        json={"mode": "Fast", "onlineLyrics": False},
    )

    assert response.status_code in {409, 503}
    assert response.json()["code"] in {"AiProviderUnavailable", "MissingRequiredModels"}


def next_client(tmp_path: Path):
    return app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),))


class _CudaOomProvider(FakeAiProvider):
    def pitch(self, vocal, cancel):
        del vocal, cancel
        raise DependencyError("CudaOutOfMemory", "simulated CUDA OOM")


def test_cuda_oom_fails_only_job_and_backend_stays_live(tmp_path: Path) -> None:
    source = tmp_path / "cuda-oom.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime-cuda-oom", ai_providers=(_CudaOomProvider(),)) as client:
        song = import_song(client, source)
        started = client.post(
            f"/songs/{song['songId']}/processing",
            json={"mode": "Fast", "onlineLyrics": False},
        )
        assert started.status_code == 202, started.text
        job = wait_for_job(client, started.json()["jobId"])

        assert job["state"] == "Failed"
        assert job["error"]["code"] == "CudaOutOfMemory"
        assert client.get("/health/live").status_code == 200
        assert client.get(f"/songs/{song['songId']}").json()["status"] == "Failed"


class _PitchOnlyProvider(FakeAiProvider):
    def __init__(self) -> None:
        super().__init__("pitch-only")
        self._descriptor = AiProviderDescriptor(
            provider_id="pitch-only",
            version="1",
            capabilities=frozenset({AiCapability.PITCH}),
            supported_languages=frozenset({"Auto", "Ukrainian", "Russian", "English"}),
            required_models=(),
            required_resources={"cpuThreads": 1},
        )


def test_melody_reprocess_uses_existing_artifacts_and_only_pitch_provider(tmp_path: Path) -> None:
    root = tmp_path / "runtime-melody"
    source = tmp_path / "melody.wav"
    write_wav(source)
    with app_client(root, ai_providers=(FakeAiProvider(),)) as client:
        song = import_song(client, source)
        started = client.post(
            f"/songs/{song['songId']}/processing",
            json={"mode": "Fast", "onlineLyrics": False},
        )
        assert wait_for_job(client, started.json()["jobId"])["state"] == "Succeeded"
        ready = client.get(f"/songs/{song['songId']}").json()
        previous_revision = ready["activeRevision"]

    with app_client(root, ai_providers=(_PitchOnlyProvider(),)) as client:
        headers = {"Idempotency-Key": "melody-once"}
        started = client.post(f"/songs/{song['songId']}/processing/melody", headers=headers)
        repeated = client.post(f"/songs/{song['songId']}/processing/melody", headers=headers)
        assert started.status_code == 202, started.text
        assert repeated.status_code == 202, repeated.text
        assert repeated.json()["jobId"] == started.json()["jobId"]
        job = wait_for_job(client, started.json()["jobId"])

        assert job["state"] == "Succeeded", job
        assert job["report"]["algorithmVersion"] == "melody-1"
        stage_names = {item["stage"] for item in job["report"]["stages"]}
        assert "PitchAnalysis" in stage_names
        assert "StemSeparation" not in stage_names
        assert "ForcedAlignment" not in stage_names
        assert "LyricsDiscovery" not in stage_names
        updated = client.get(f"/songs/{song['songId']}").json()
        assert updated["activeRevision"] == previous_revision + 1
        assert updated["status"] == "Ready"


class _CrashingProvider(FakeAiProvider):
    def pitch(self, vocal, cancel):
        raise RuntimeError("provider bug")


def test_unexpected_provider_crash_does_not_leave_the_song_processing(tmp_path: Path) -> None:
    source = tmp_path / "crash.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime-crash", ai_providers=(_CrashingProvider(),)) as client:
        song = import_song(client, source)
        started = client.post(
            f"/songs/{song['songId']}/processing",
            json={"mode": "Fast", "onlineLyrics": False},
        )
        job = wait_for_job(client, started.json()["jobId"])

        assert job["state"] == "Failed"
        assert client.get(f"/songs/{song['songId']}").json()["status"] == "Failed"
        again = client.post(
            f"/songs/{song['songId']}/processing",
            json={"mode": "Fast", "onlineLyrics": False},
        )
        assert again.status_code == 202, again.text
