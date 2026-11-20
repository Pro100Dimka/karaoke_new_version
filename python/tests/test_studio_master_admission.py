from threading import Event
from pathlib import Path
from shutil import copyfile
from types import SimpleNamespace

import pytest

from backend.domain_errors import DomainError
from backend.processing.domain import JobType
from backend.processing.policies import ResourceBudget
from backend.processing.resource_scheduler import ProcessingResourceScheduler
from backend.recordings.start_studio_master import StartStudioMaster
from backend.settings.domain import BackendSettings
from tests.fakes import FakeAiProvider
from tests.helpers import wait_for_job
from tests.test_resource_scheduler import FakeRuntimeProbe, FakeStorage
from tests.test_studio_master_lifecycle import _render, _start
from tests.test_studio_master_lifecycle import mastering as mastering


def test_waiting_processing_cannot_take_the_budget_from_a_preparing_master(mastering, monkeypatch):
    session = mastering
    service = session.service
    manager = session.container.system.jobs
    preparing, prepare, occupied, release, admitted = (Event() for _ in range(5))
    leases = []
    original = session.audio.read_bytes()

    def stems(recording):
        preparing.set()
        assert prepare.wait(5)
        return recording.file_path, recording.file_path

    def render(recording, *args):
        with service._render_budget(recording):
            return _render(recording, *args)

    def hold_worker(_context):
        occupied.set()
        assert release.wait(5)

    def admit(cancel):
        while not cancel.is_set():
            try:
                leases.append(service._resources.claim_cpu(session.audio.stat().st_size))
                admitted.set()
                return
            except DomainError as error:
                if error.code != "ResourceBudgetExceeded":
                    raise
                cancel.wait(0.05)

    monkeypatch.setattr(service, "_stems", stems)
    monkeypatch.setattr(service, "_render", render)
    master = _start(session)
    waiting = None
    try:
        assert preparing.wait(2)
        manager.start(JobType.SONG_IMPORT, hold_worker)
        assert occupied.wait(2)
        waiting = manager.start(
            JobType.SONG_PROCESSING,
            lambda _context: None,
            admit=admit,
            on_finally=lambda: [lease.release() for lease in leases],
        )
        admitted.wait(0.2)  # Give admission a chance while both execution workers are occupied.
        prepare.set()
        result = wait_for_job(session.client, master)
        assert result["state"] == "Succeeded", result
        assert wait_for_job(session.client, waiting.job_id)["state"] == "Succeeded"
        assert session.audio.read_bytes() == original
    finally:
        prepare.set()
        release.set()
        if waiting is not None:
            manager.cancel(waiting.job_id)


@pytest.mark.parametrize("recoverable", [False, True], ids=["exact", "recoverable"])
def test_master_with_existing_sources_needs_only_cpu_and_recovers_under_its_lease(
    mastering, monkeypatch, recoverable
):
    session, recovered, rendered = mastering, [], []
    service = session.service
    resources = service._resources
    original = session.audio.read_bytes()
    if recoverable:
        for suffix in (".dry.wav", ".vocal.wav"):
            Path(str(session.audio) + suffix).unlink()

    def unavailable(*_args, **_kwargs):
        pytest.fail("Exact/recoverable stems must not resolve a neural provider or probe CUDA")

    def recover(path):
        assert resources._reserved_cpu > 0
        recovered.append(path)
        copyfile(path, Path(str(path) + ".vocal.wav"))

    def render(recording, *args):
        with service._render_budget(recording) as workers:
            assert workers == resources._reserved_cpu > 0
            rendered.append(True)
            return _render(recording, *args)

    monkeypatch.setattr(service, "_stems", StartStudioMaster._stems.__get__(service))
    monkeypatch.setattr(service._resolver, "execute", unavailable)
    monkeypatch.setattr(resources, "_runtime", SimpleNamespace(inspect=unavailable))
    monkeypatch.setattr(service._renderer, "preserve_stems", recover)
    monkeypatch.setattr(service, "_render", render)
    result = wait_for_job(session.client, _start(session))
    assert result["state"] == "Succeeded", result
    session.container.executor.shutdown()
    assert resources._reserved_cpu == 0
    assert recovered == ([session.audio] if recoverable else [])
    assert rendered == [True] and session.audio.read_bytes() == original


@pytest.mark.parametrize("outcome", ["success", "separation-failure", "render-failure", "cancel"])
def test_master_releases_model_memory_before_render_and_cpu_after_settlement(
    mastering, monkeypatch, outcome
):
    session = mastering
    service = session.service
    original = session.audio.read_bytes()
    for suffix in (".dry.wav", ".vocal.wav", ".backing.wav"):
        Path(str(session.audio) + suffix).unlink()
    resources = ProcessingResourceScheduler(
        FakeRuntimeProbe(cuda=True, total_vram=4096, free_vram=4096),
        FakeStorage(),
        session.audio.parent,
        ResourceBudget(cpu_threads=4, min_free_ram_bytes=0, min_free_disk_bytes=0),
    )
    provider = FakeAiProvider(
        required_resources={"supportsCuda": True, "ramBytes": 512, "vramBytes": 1024}
    )
    separate = provider.separate
    separated, rendered = [], []

    def separation(*args, **kwargs):
        assert (resources._reserved_cpu, resources._reserved_ram, resources._reserved_vram) == (
            2,
            512,
            1024,
        )
        separated.append(True)
        if outcome == "separation-failure":
            raise DomainError("AiProcessFailed", "Separation failed", 500)
        return separate(*args, **kwargs)

    def render(recording, *args):
        assert (resources._reserved_cpu, resources._reserved_ram, resources._reserved_vram) == (
            2,
            0,
            0,
        )
        with service._render_budget(recording) as workers:
            assert workers == 2
            rendered.append(True)
            if outcome == "render-failure":
                raise DomainError("StudioMasterFailed", "Render failed", 500)
            if outcome == "cancel":
                session.container.system.jobs.cancel(args[-1].job_id)
            return _render(recording, *args)

    monkeypatch.setattr(service, "_resources", resources)
    monkeypatch.setattr(service, "_settings", lambda: BackendSettings(1, cpu_threads=2))
    monkeypatch.setattr(service, "_resolver", SimpleNamespace(execute=lambda *_: provider))
    monkeypatch.setattr(service, "_stems", StartStudioMaster._stems.__get__(service))
    monkeypatch.setattr(provider, "separate", separation)
    monkeypatch.setattr(service, "_render", render)
    result = wait_for_job(session.client, _start(session))
    expected = (
        "Succeeded" if outcome == "success" else "Cancelled" if outcome == "cancel" else "Failed"
    )
    assert result["state"] == expected, result
    session.container.executor.shutdown()
    assert separated == [True]
    assert rendered == ([] if outcome == "separation-failure" else [True])
    assert (resources._reserved_cpu, resources._reserved_ram, resources._reserved_vram) == (0, 0, 0)
    assert session.audio.read_bytes() == original


def test_waiting_master_can_be_cancelled_without_taking_or_leaking_a_budget(mastering, monkeypatch):
    session = mastering
    resources = session.service._resources
    holder = resources.claim_cpu(session.audio.stat().st_size)
    reserved = resources._reserved_cpu
    waiting = Event()
    claim = resources.claim_cpu

    def observe(*args, **kwargs):
        try:
            return claim(*args, **kwargs)
        except DomainError as error:
            if error.code == "ResourceBudgetExceeded":
                waiting.set()
            raise

    monkeypatch.setattr(resources, "claim_cpu", observe)
    try:
        identity = _start(session)
        assert waiting.wait(2)
        assert _start(session) == identity
        session.container.system.jobs.cancel(identity)
        assert wait_for_job(session.client, identity)["state"] == "Cancelled"
        session.container.executor.shutdown()
        assert resources._reserved_cpu == reserved
        assert not tuple(session.container.roots.temp.glob("studio-*"))
    finally:
        holder.release()
    assert resources._reserved_cpu == 0
