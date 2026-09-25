from dataclasses import replace
from unittest.mock import Mock

from backend.bootstrap.build import _processing_wiring
from backend.bootstrap.config import BackendConfig
from backend.infrastructure import runtime_probe
from backend.infrastructure.process_runner import ProcessResult
from backend.infrastructure.runtime_probe import SystemRuntimeProbe
from tests.fakes import FakeAiProvider
from tests.test_resource_scheduler import FakeStorage


def test_configured_probe_refreshes_available_memory_between_jobs(tmp_path, monkeypatch):
    monkeypatch.setattr(runtime_probe, "_memory_bytes", lambda: (16000, 8000))
    monkeypatch.setattr(
        runtime_probe, "_torch_data", lambda: ("test", True, "test", "gpu", 8000, 6000)
    )
    runner = Mock()
    runner.run.return_value = ProcessResult(0, b"ffmpeg test", b"")
    wiring = _processing_wiring(
        BackendConfig.load(tmp_path), runner, Mock(), (FakeAiProvider(),), (), FakeStorage()
    )
    first = wiring.runtime.inspect()
    monkeypatch.setattr(runtime_probe, "_memory_bytes", lambda: (16000, 1000))
    monkeypatch.setattr(
        runtime_probe, "_torch_data", lambda: ("test", True, "test", "gpu", 8000, 500)
    )
    assert wiring.runtime.inspect() == replace(first, available_ram_bytes=1000, free_vram_bytes=500)
    assert runner.run.call_count == 1


def test_memory_refresh_does_not_relaunch_the_ffmpeg_version_probe(monkeypatch):
    monkeypatch.setattr(runtime_probe, "_torch_data", lambda: (None, False, None, None, None, None))
    runner = Mock()
    runner.run.return_value = ProcessResult(0, b"ffmpeg test", b"")
    probe = SystemRuntimeProbe(runner)
    assert probe.inspect().ffmpeg_version == "ffmpeg test"
    assert probe.inspect().ffmpeg_version == "ffmpeg test"
    assert runner.run.call_count == 1
