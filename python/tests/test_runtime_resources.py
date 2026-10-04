import sys
from dataclasses import replace
from unittest.mock import Mock

import pytest

from backend.bootstrap.build import _processing_wiring
from backend.bootstrap.config import BackendConfig
from backend.domain_errors import DependencyError
from backend.infrastructure import runtime_probe
from backend.infrastructure.process_runner import ProcessResult
from backend.infrastructure.runtime_probe import SystemRuntimeProbe
from tests.fakes import FakeAiProvider
from tests.test_resource_scheduler import FakeStorage

MIB = 1024 * 1024
CUDA_FACTS = (b'{"version": "2.9", "cuda": true, "runtime": "13.0", "gpu": "RTX Test",'
              b' "total": 8000, "free": 6000}\n')


@pytest.fixture(autouse=True)
def fresh_torch_probe(monkeypatch):
    """Each test starts as a newly launched backend that has not probed PyTorch yet."""
    monkeypatch.setattr(runtime_probe, "_torch_cache", None)


class Runner:
    """Answers the three probes the runtime inspection launches and counts each of them."""

    def __init__(self, torch: ProcessResult, smi: ProcessResult | None = None) -> None:
        self.torch, self.smi = torch, smi
        self.calls: list[str] = []

    def run(self, command, *, timeout_seconds, **_):
        name = "torch" if command[0] == sys.executable else command[0]
        self.calls.append(name)
        if name == "torch":
            return self.torch
        if name == "nvidia-smi":
            if self.smi is None:
                raise DependencyError("ProcessUnavailable", "nvidia-smi is not installed")
            return self.smi
        return ProcessResult(0, b"ffmpeg test", b"")


def test_torch_is_never_imported_into_the_backend_process(monkeypatch):
    monkeypatch.delitem(sys.modules, "torch", raising=False)
    runner = Runner(ProcessResult(0, CUDA_FACTS, b""), ProcessResult(0, b"RTX Test, 8192, 7000\n", b""))
    diagnostics = SystemRuntimeProbe(runner).inspect()
    assert "torch" not in sys.modules
    assert diagnostics.pytorch_version == "2.9"
    assert diagnostics.cuda_available is True
    assert diagnostics.gpu_name == "RTX Test"
    assert (diagnostics.vram_bytes, diagnostics.free_vram_bytes) == (8192 * MIB, 7000 * MIB)


def test_configured_probe_refreshes_free_memory_without_probing_torch_again(tmp_path, monkeypatch):
    monkeypatch.setattr(runtime_probe, "_memory_bytes", lambda: (16000, 8000))
    runner = Runner(ProcessResult(0, CUDA_FACTS, b""), ProcessResult(0, b"RTX Test, 8192, 7000\n", b""))
    wiring = _processing_wiring(
        BackendConfig.load(tmp_path), runner, Mock(), (FakeAiProvider(),), (), FakeStorage()
    )
    first = wiring.runtime.inspect()
    monkeypatch.setattr(runtime_probe, "_memory_bytes", lambda: (16000, 1000))
    runner.smi = ProcessResult(0, b"RTX Test, 8192, 500\n", b"")
    assert wiring.runtime.inspect() == replace(first, available_ram_bytes=1000, free_vram_bytes=500 * MIB)
    assert runner.calls.count("torch") == 1
    assert runner.calls.count("ffmpeg") == 1


def test_picks_the_gpu_pytorch_uses_when_the_driver_lists_several():
    smi = ProcessResult(0, b"Other GPU, 4096, 4000\nRTX Test, 8192, 7000\n", b"")
    diagnostics = SystemRuntimeProbe(Runner(ProcessResult(0, CUDA_FACTS, b""), smi)).inspect()
    assert diagnostics.free_vram_bytes == 7000 * MIB


def test_falls_back_to_the_probe_memory_when_the_driver_tool_is_missing():
    diagnostics = SystemRuntimeProbe(Runner(ProcessResult(0, CUDA_FACTS, b""))).inspect()
    assert (diagnostics.vram_bytes, diagnostics.free_vram_bytes) == (8000, 6000)


def test_cpu_only_pytorch_reports_no_gpu_and_skips_the_driver_tool():
    runner = Runner(ProcessResult(0, b'{"version": "2.9", "cuda": false}\n', b""))
    diagnostics = SystemRuntimeProbe(runner).inspect()
    assert (diagnostics.pytorch_version, diagnostics.cuda_available, diagnostics.gpu_name) == ("2.9", False, None)
    assert "nvidia-smi" not in runner.calls


def test_failed_torch_probe_does_not_break_diagnostics_and_is_tried_again():
    runner = Runner(ProcessResult(1, b"", b"ImportError: DLL load failed"))
    probe = SystemRuntimeProbe(runner)
    first = probe.inspect()
    assert (first.pytorch_version, first.cuda_available, first.vram_bytes) == (None, False, None)
    runner.torch = ProcessResult(0, b"not json\n", b"")
    assert probe.inspect().pytorch_version is None
    runner.torch = ProcessResult(0, b'{"version": "2.9", "cuda": false}\n', b"")
    assert probe.inspect().pytorch_version == "2.9"
    assert runner.calls.count("torch") == 3


def test_a_successful_probe_is_shared_by_every_probe_in_the_process():
    first = Runner(ProcessResult(0, b'{"version": "2.9", "cuda": false}\n', b""))
    second = Runner(ProcessResult(0, b'{"version": "other", "cuda": false}\n', b""))
    SystemRuntimeProbe(first).inspect()
    assert SystemRuntimeProbe(second).inspect().pytorch_version == "2.9"
    assert "torch" not in second.calls
