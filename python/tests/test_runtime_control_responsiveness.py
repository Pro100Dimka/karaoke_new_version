from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from threading import Event
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from backend.bootstrap.build import _processing_wiring
from backend.bootstrap.config import BackendConfig
from backend.bootstrap.lifecycle import BackendLifecycle
from backend.bootstrap.system_wiring import build_system_cases
from backend.infrastructure import runtime_probe
from backend.infrastructure.process_runner import ProcessResult
from backend.models.domain import ComputeMode
from backend.settings.domain import BackendSettings
from tests.fakes import FakeAiProvider
from tests.test_resource_scheduler import FakeStorage


class _HeldGpuProbe:
    def __init__(self):
        self.entered, self.release = Event(), Event()
        self.commands = []

    def run(self, command, **_kwargs):
        self.commands.append(command[0])
        if command[0] == "nvidia-smi":
            self.entered.set()
            assert self.release.wait(3), "The GPU probe was not released"
            return ProcessResult(0, b"RTX Test, 8192, 7000\n", b"")
        assert command[0] == "ffmpeg", "A warm runtime must not probe PyTorch again"
        return ProcessResult(0, b"ffmpeg version 8.0 Copyright", b"")


@pytest.fixture
def warmed_runtime(tmp_path, monkeypatch):
    mib = 1024 * 1024
    facts = runtime_probe._TorchFacts("2.9", True, "13.0", "RTX Test", 8192 * mib, 6000 * mib)
    monkeypatch.setattr(runtime_probe, "_torch_cache", facts)
    probe = _HeldGpuProbe()
    settings = BackendSettings(1)
    transaction = SimpleNamespace(
        settings=SimpleNamespace(get=lambda: settings),
        models=SimpleNamespace(missing=lambda _models: ()),
    )
    database = SimpleNamespace(create=lambda: nullcontext(transaction))
    config = BackendConfig.load(tmp_path)
    provider = FakeAiProvider(required_resources={"supportsCuda": True})
    processing = _processing_wiring(config, probe, Mock(), (provider,), (), FakeStorage())
    cases = build_system_cases(
        SimpleNamespace(database=database, config=config),
        SimpleNamespace(journal=SimpleNamespace(entries=lambda: ()), operations=Mock()),
        processing,
        BackendLifecycle(),
        Mock(stats=lambda: {}),
        lambda: settings,
        Mock(),
    )
    yield SimpleNamespace(probe=probe, processing=processing, cases=cases, provider=provider)
    probe.release.set()


@pytest.mark.parametrize("operation", ["cpu", "capabilities"])
def test_cpu_admission_and_capabilities_do_not_wait_for_gpu_memory(warmed_runtime, operation):
    runtime = warmed_runtime
    action = (
        (lambda: runtime.processing.resources.claim_provider(runtime.provider, 0, ComputeMode.CPU))
        if operation == "cpu"
        else runtime.cases.capabilities.execute
    )
    with ThreadPoolExecutor(max_workers=1) as worker:
        result = worker.submit(action)
        try:
            value = result.result(timeout=0.3)
            if operation == "cpu":
                assert value.execution.device.value == "CPU"
                value.release()
            else:
                assert value.can_use_cuda and value.can_import_songs
            assert "nvidia-smi" not in runtime.probe.commands
        finally:
            runtime.probe.release.set()


@pytest.mark.parametrize("operation", ["cuda", "diagnostics"])
def test_cuda_admission_and_explicit_diagnostics_still_refresh_gpu_memory(
    warmed_runtime, operation
):
    runtime = warmed_runtime
    action = (
        (lambda: runtime.processing.resources.claim_provider(runtime.provider, 0, ComputeMode.AUTO))
        if operation == "cuda"
        else runtime.cases.diagnostics.execute
    )
    with ThreadPoolExecutor(max_workers=1) as worker:
        result = worker.submit(action)
        try:
            assert runtime.probe.entered.wait(1)
            assert not result.done()
            runtime.probe.release.set()
            value = result.result(timeout=2)
            if operation == "cuda":
                assert value.execution.device.value == "CUDA"
                value.release()
            else:
                assert value["ai"]["free_vram_bytes"] == 7000 * 1024 * 1024
                assert value["ai"]["vram_is_current"] is True
        finally:
            runtime.probe.release.set()
