from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor, wait
from pathlib import Path

import pytest

from backend.domain_errors import ConflictError, DomainError
from backend.packages.domain import PackageImportDecision
from backend.processing.domain import JobType
from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.test_packages_e2e import make_ready_and_export


@pytest.mark.parametrize("same_input", [True, False])
def test_overlapping_package_imports_reserve_an_idempotency_key_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, same_input: bool
) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        _, package = make_ready_and_export(client, source)
        starter = client.app.state.container.packages.start_import
        save = starter._save
        entered, release = threading.Event(), threading.Event()
        guard = threading.Lock()

        def paused_save(*args):
            with guard:
                first = not entered.is_set()
                entered.set()
            if first:
                assert release.wait(10), "Second import request did not finish"
            return save(*args)

        monkeypatch.setattr(starter, "_save", paused_save)
        decision = (
            PackageImportDecision.SAFE_ONLY
            if same_input
            else PackageImportDecision.ACCEPT_DIVERGENT
        )
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(
                starter.execute, package, PackageImportDecision.SAFE_ONLY, "shared-key"
            )
            try:
                assert entered.wait(10), "First import did not reach idempotency persistence"
                second = pool.submit(starter.execute, package, decision, "shared-key")
                wait((second,), timeout=1)
            finally:
                release.set()
            original = first.result(timeout=10)
            if same_input:
                assert second.result(timeout=10).job_id == original.job_id
            else:
                with pytest.raises(ConflictError) as conflict:
                    second.result(timeout=10)
                assert conflict.value.code == "IdempotencyConflict"

        with starter._uow.create() as transaction:
            assert transaction.jobs.count(job_type=JobType.PACKAGE_IMPORT) == 1


def test_failed_package_preflight_does_not_reserve_an_idempotency_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        _, package = make_ready_and_export(client, source)
        starter = client.app.state.container.packages.start_import
        preflight = starter._preflight.execute

        def fail_preflight(path: Path) -> None:
            raise DomainError("InsufficientDiskSpace", "Import requires more disk space", 503)

        monkeypatch.setattr(starter._preflight, "execute", fail_preflight)
        with pytest.raises(DomainError, match="disk space"):
            starter.execute(package, PackageImportDecision.SAFE_ONLY, "retry-key")
        with starter._uow.create() as transaction:
            assert transaction.jobs.count(job_type=JobType.PACKAGE_IMPORT) == 0
            assert transaction.idempotency.get("ImportPackage", "retry-key") is None

        monkeypatch.setattr(starter._preflight, "execute", preflight)
        started = starter.execute(package, PackageImportDecision.ACCEPT_DIVERGENT, "retry-key")
        replay = starter.execute(package, PackageImportDecision.ACCEPT_DIVERGENT, "retry-key")
        assert replay.job_id == started.job_id
        with starter._uow.create() as transaction:
            assert transaction.jobs.count(job_type=JobType.PACKAGE_IMPORT) == 1
