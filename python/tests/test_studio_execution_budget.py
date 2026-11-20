from types import SimpleNamespace
from contextvars import ContextVar

import pytest

from backend.models.domain import ComputeMode
from backend.recordings.start_studio_master import StartStudioMaster
from backend.processing.policies import ResourceBudget
from backend.processing.resource_scheduler import ProcessingResourceScheduler
from tests.test_resource_scheduler import FakeRuntimeProbe, FakeStorage


def test_local_render_reserves_cpu_without_probing_gpu(tmp_path):
    def gpu():
        pytest.fail("Offline rendering must not inspect CUDA")

    budget = ResourceBudget(cpu_threads=4, min_free_ram_bytes=0, min_free_disk_bytes=0)
    scheduler = ProcessingResourceScheduler(
        SimpleNamespace(inspect=gpu),
        FakeStorage(),
        tmp_path,
        budget,
        cpu_runtime=FakeRuntimeProbe(),
    )
    lease = scheduler.claim_cpu(1234, cpu_threads=99)
    assert lease.execution.cpu_threads == 4
    assert scheduler._reserved_cpu == 4 and scheduler._reserved_vram == 0
    lease.release()
    assert scheduler._reserved_cpu == 0


@pytest.mark.parametrize("failed", [False, True])
def test_render_budget_honors_settings_and_releases_after_failure(tmp_path, failed):
    requested, released = [], []
    source = tmp_path / "capture.wav"
    source.write_bytes(b"capture")

    def claim(source_bytes, *, cpu_threads):
        requested.append((source_bytes, cpu_threads))
        return SimpleNamespace(
            execution=SimpleNamespace(cpu_threads=3), release=lambda: released.append(True)
        )

    service = StartStudioMaster.__new__(StartStudioMaster)
    service._admitted = ContextVar("test_master_resources", default=None)
    service._resources = SimpleNamespace(claim_cpu=claim)
    service._settings = lambda: SimpleNamespace(cpu_threads=3, compute_mode=ComputeMode.AUTO)
    try:
        with service._render_budget(SimpleNamespace(file_path=source)) as workers:
            assert workers == 3 and not released
            if failed:
                raise ValueError("render failed")
    except ValueError:
        assert failed
    assert requested == [(7, 3)] and released == [True]
