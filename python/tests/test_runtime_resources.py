from dataclasses import replace
from unittest.mock import Mock
from types import SimpleNamespace

import pytest

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


@pytest.mark.parametrize("failure", [ImportError("missing"), OSError("DLL unavailable"), RuntimeError("runtime unavailable")])
def test_unavailable_torch_does_not_break_runtime_diagnostics(monkeypatch, failure):
    monkeypatch.setattr(runtime_probe.importlib, "import_module", Mock(side_effect=failure))
    assert runtime_probe._torch_data() == (None, False, None, None, None, None)


@pytest.mark.parametrize("operation,result", [
    ("is_available", True), ("get_device_name", "runtime GPU"), ("mem_get_info", (6000, 8000)),
])
def test_cuda_driver_failure_falls_back_and_is_probed_again(monkeypatch, operation, result):
    cuda = Mock()
    cuda.is_available.return_value = True
    cuda.get_device_name.return_value = "runtime GPU"
    cuda.mem_get_info.return_value = (6000, 8000)
    getattr(cuda, operation).side_effect = [RuntimeError("driver unavailable"), result]
    torch = SimpleNamespace(__version__="test", version=SimpleNamespace(cuda="runtime"), cuda=cuda)
    monkeypatch.setattr(runtime_probe.importlib, "import_module", lambda _: torch)
    assert runtime_probe._torch_data() == ("test", False, None, None, None, None)
    assert runtime_probe._torch_data() == ("test", True, "runtime", "runtime GPU", 8000, 6000)
