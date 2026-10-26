from __future__ import annotations

from pathlib import Path
from unittest.mock import Mock, call

import pytest

from backend.ai.domain import AiCapability
from backend.models.domain import ComputeMode
from backend.processing.compute_policy import ComputeDevice
from backend.infrastructure.runtime_probe import SystemRuntimeProbe
from backend.processing.reprocess_melody import ReprocessMelody
from backend.settings.domain import BackendSettings, ProcessingBackend
from backend.songs.domain import SongStatus
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
        import soundfile as sf

        self.executions["align"] = kwargs.get("execution")
        self.alignment_audio = (args[0], kwargs.get("instrumental"))
        self.alignment_audio_info = tuple(
            (sf.info(path).frames, sf.info(path).samplerate)
            for path in self.alignment_audio
            if path is not None
        )
        return super().align(*args, **kwargs)

    def pitch(self, *args, **kwargs):
        self.executions["pitch"] = kwargs.get("execution")
        return super().pitch(*args, **kwargs)


def test_cuda_alignment_with_catalog_times_overlaps_pitch_within_the_thread_budget(monkeypatch):
    import threading
    from types import SimpleNamespace
    from backend.infrastructure.job_executor import ThreadConcurrentRunner
    from backend.processing.document_pipeline import BuildProcessingDocument
    from backend.processing.compute_policy import ExecutionContext
    from backend.lyrics.discovery import LyricsDiscoveryResult
    from backend.lyrics.domain import LyricsDocument
    from backend.lyrics.ports import LyricLineTiming

    pipeline = BuildProcessingDocument(Mock(), Mock(), ThreadConcurrentRunner())
    barrier = threading.Barrier(2)
    threads = []

    def stage(*args):
        threads.append(args[-1].cpu_threads)
        barrier.wait(timeout=2)
        return ()

    monkeypatch.setattr(
        pipeline,
        "_discover",
        lambda *_: LyricsDiscoveryResult(
            "we sing", "catalog", (), (LyricLineTiming(1, "we sing"),)
        ),
    )
    monkeypatch.setattr(pipeline, "_align", stage)
    monkeypatch.setattr(pipeline, "_stable_pitch", stage)
    monkeypatch.setattr(
        pipeline, "_construct", lambda *_: LyricsDocument("T", "A", 2, None, None, "", ())
    )
    pipeline.run(
        Mock(),
        SimpleNamespace(rhythm=()),
        Mock(),
        Mock(),
        Mock(),
        [],
        ExecutionContext(ComputeDevice.CUDA, 8),
    )
    assert sum(threads) == 8
    assert all(count > 0 for count in threads)


@pytest.mark.parametrize("realign", [False, True])
def test_full_and_existing_alignment_receive_the_backing_from_the_same_timeline(tmp_path, realign):
    source = tmp_path / "song.wav"
    write_wav(source)
    provider = ExecutionTrackingProvider()
    with app_client(tmp_path / "runtime", ai_providers=(provider,)) as client:
        song = import_song(client, source)
        job = client.post(
            f"/songs/{song['songId']}/processing", json={"mode": "Fast", "onlineLyrics": False}
        )
        assert wait_for_job(client, job.json()["jobId"])["state"] == "Succeeded"
        if realign:
            job = client.post(f"/songs/{song['songId']}/processing/lyrics")
            assert wait_for_job(client, job.json()["jobId"])["state"] == "Succeeded"

        vocal, backing = provider.alignment_audio
        assert backing is not None, "A vocal stem alone cannot identify leaked accompaniment"
        assert vocal != backing
        assert len(provider.alignment_audio_info) == 2
        assert provider.alignment_audio_info[0] == provider.alignment_audio_info[1]


def test_melody_reprocess_uses_one_settings_snapshot(monkeypatch: pytest.MonkeyPatch) -> None:
    first = BackendSettings(
        settings_schema_version=1,
        compute_mode=ComputeMode.CPU,
        cpu_threads=2,
        selected_pitch_provider="preferred",
    )
    changed = BackendSettings(
        settings_schema_version=1, compute_mode=ComputeMode.CUDA, cpu_threads=4
    )
    settings = Mock()
    settings.side_effect = [first, changed, changed]
    song = Mock(status=SongStatus.READY, song_id="song-1")
    pipeline = Mock()
    pipeline.resource_size.return_value = 42
    persistence = Mock()
    persistence.repeated_job.return_value = None
    persistence.load_song.return_value = song
    resolver = Mock()
    provider = FakeAiProvider()
    resolver.execute.return_value = provider
    resources = Mock()
    expected_job = Mock(job_id="job-1")
    action = ReprocessMelody(Mock(), settings, resolver, resources, pipeline, Mock(), persistence)
    monkeypatch.setattr(action, "_start", lambda *args: expected_job)

    assert action.execute("song-1", idempotency_key=None, correlation_id=None) is expected_job
    settings.assert_called_once_with()
    resolver.execute.assert_called_once_with(AiCapability.PITCH, "preferred")
    resources.claim_provider.assert_called_once_with(
        provider, 42, ComputeMode.CPU, cpu_threads=2, additional_providers=()
    )


@pytest.mark.parametrize("realign", [False, True])
def test_reprocess_uses_remote_backend_for_only_required_capabilities_and_initial_report(realign):
    current = BackendSettings(
        2,
        compute_mode=ComputeMode.CUDA,
        cpu_threads=2,
        selected_pitch_provider="unavailable-local",
        selected_alignment_provider="unavailable-local",
        processing_backend=ProcessingBackend.KAGGLE,
    )
    settings = Mock()
    settings.return_value = current
    persistence = Mock()
    persistence.repeated_job.return_value = None
    persistence.load_song.return_value = Mock(status=SongStatus.READY, song_id="song-1")
    pipeline = Mock()
    pipeline.resource_size.return_value = 42
    remote = FakeAiProvider("kaggle-p100", required_resources={"remote": True})
    resolver = Mock()
    resolver.execute.return_value = remote
    resources, jobs = Mock(), Mock()
    action = ReprocessMelody(jobs, settings, resolver, resources, pipeline, Mock(), persistence)

    action.execute("song-1", idempotency_key=None, correlation_id=None, realign_lyrics=realign)

    expected = [call(AiCapability.PITCH, "kaggle-p100")]
    if realign:
        expected.append(call(AiCapability.ALIGNMENT, "kaggle-p100"))
    assert resolver.execute.call_args_list == expected
    resources.claim_provider.assert_called_once_with(
        remote,
        42,
        ComputeMode.CPU,
        cpu_threads=2,
        additional_providers=(remote,) if realign else (),
    )
    assert jobs.start.call_args.kwargs["initial_report"]["processingBackend"] == "Kaggle"


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
