from __future__ import annotations

from pathlib import Path

import pytest

from backend.processing.compute_policy import ComputeDevice
from backend.infrastructure.runtime_probe import SystemRuntimeProbe
from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.helpers import import_song, wait_for_job
from tests.test_resource_scheduler import FakeRuntimeProbe


class ExecutionTrackingProvider(FakeAiProvider):
    def __init__(self):
        super().__init__(required_resources={"supportsCuda": True, "cpuThreads": 8})
        self.executions = {}

    def separate(self, *args, **kwargs):
        self.executions["separate"] = kwargs.get("execution")
        return super().separate(*args, **kwargs)

    def transcribe(self, *args, **kwargs):
        self.executions["transcribe"] = kwargs.get("execution")
        return super().transcribe(*args, **kwargs)

    def align(self, *args, **kwargs):
        self.executions["align"] = kwargs.get("execution")
        return super().align(*args, **kwargs)

    def pitch(self, *args, **kwargs):
        self.executions["pitch"] = kwargs.get("execution")
        return super().pitch(*args, **kwargs)


@pytest.mark.parametrize("mode,device", [("CPU", ComputeDevice.CPU), ("CUDA", ComputeDevice.CUDA)])
def test_every_ai_stage_receives_the_selected_device_and_cpu_budget(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mode: str, device: ComputeDevice
) -> None:
    runtime = FakeRuntimeProbe(
        available_ram=16 * 1024**3, cuda=True, total_vram=8 * 1024**3, free_vram=8 * 1024**3
    ).inspect()
    monkeypatch.setattr(SystemRuntimeProbe, "inspect", lambda self: runtime)
    provider = ExecutionTrackingProvider()
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(provider,)) as client:
        settings = client.patch("/settings", json={"computeMode": mode, "cpuThreads": 2})
        assert settings.status_code == 200, settings.text
        song = import_song(client, source)
        started = client.post(
            f"/songs/{song['songId']}/processing", json={"mode": "Fast", "onlineLyrics": False}
        )
        job = wait_for_job(client, started.json()["jobId"])
        assert job["state"] == "Succeeded", job
        assert set(provider.executions) == {"separate", "transcribe", "align", "pitch"}
        for stage, threads in {"separate": 2, "transcribe": 1, "align": 1, "pitch": 1}.items():
            execution = provider.executions[stage]
            assert execution is not None, stage
            assert (execution.device, execution.cpu_threads) == (device, threads)

        provider.executions.clear()
        started = client.post(f"/songs/{song['songId']}/processing/melody")
        job = wait_for_job(client, started.json()["jobId"])
        assert job["state"] == "Succeeded", job
        execution = provider.executions["pitch"]
        assert execution is not None
        assert (execution.device, execution.cpu_threads) == (device, 2)
