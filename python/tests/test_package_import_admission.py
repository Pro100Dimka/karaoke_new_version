from __future__ import annotations

import os
import shutil
import threading
import zipfile
from collections.abc import Callable
from pathlib import Path

import pytest

from backend.domain_errors import DomainError
from backend.packages.domain import PackageImportDecision
from backend.packages.import_package import PackageImportResult
from backend.processing.domain import JobType
from tests.conftest import app_client
from tests.helpers import wait_for_job
from tests.test_package_covers import SONG_ID, _package

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("key", [None, ""], ids=["no-header", "empty-header"])
def test_unkeyed_import_creates_a_cancellable_job_without_hashing_the_archive(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, key: str | None
) -> None:
    package = _package(tmp_path / "package")
    with app_client(tmp_path / "runtime") as client:
        starter = client.app.state.container.packages.start_import
        hasher = starter._hasher
        import_package = starter._import.execute
        hashed: list[Path] = []
        entered, release = threading.Event(), threading.Event()

        def observe_hash(path: Path) -> str:
            hashed.append(path)
            return hasher(path)

        def paused_import(
            path: Path,
            *,
            decision: PackageImportDecision,
            ensure_not_cancelled: Callable[[], None] | None = None,
        ) -> PackageImportResult:
            entered.set()
            assert release.wait(10), "Import job was not released"
            return import_package(
                path, decision=decision, ensure_not_cancelled=ensure_not_cancelled
            )

        monkeypatch.setattr(starter, "_hasher", observe_hash)
        monkeypatch.setattr(starter._import, "execute", paused_import)
        try:
            response = client.post(
                "/packages/import",
                json={"path": str(package), "decision": "SafeOnly"},
                headers={} if key is None else {"Idempotency-Key": key},
            )
            assert response.status_code == 202, response.text
            assert entered.wait(5), "The background import did not start"
            job_id = response.json()["jobId"]
            cancel = client.post(f"/jobs/{job_id}/cancel")
            assert cancel.status_code == 200, cancel.text
            assert cancel.json()["state"] == "Cancelling"
            assert not release.is_set()
            print(f"package admission: archive_digest_calls={len(hashed)}")
            assert hashed == [], "A no-key import read the whole archive before returning its job"
            with starter._uow.create() as transaction:
                assert transaction.jobs.count(job_type=JobType.PACKAGE_IMPORT) == 1
                assert transaction.idempotency.get("ImportPackage", "") is None
        finally:
            release.set()

        assert wait_for_job(client, job_id)["state"] == "Cancelled"
        assert client.get(f"/songs/{SONG_ID}").status_code == 404


def test_unkeyed_import_still_rejects_failed_preflight_without_creating_a_job(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    package = _package(tmp_path / "package")
    with app_client(tmp_path / "runtime") as client:
        starter = client.app.state.container.packages.start_import
        checked: list[Path] = []

        def fail_preflight(path: Path) -> None:
            checked.append(path)
            raise DomainError("InsufficientDiskSpace", "Import requires more disk space", 503)

        monkeypatch.setattr(starter._preflight, "execute", fail_preflight)
        response = client.post(
            "/packages/import", json={"path": str(package), "decision": "SafeOnly"}
        )
        assert response.status_code == 503, response.text
        assert response.json()["code"] == "InsufficientDiskSpace"
        assert checked == [package]
        with starter._uow.create() as transaction:
            assert transaction.jobs.count(job_type=JobType.PACKAGE_IMPORT) == 0
            assert transaction.idempotency.get("ImportPackage", "") is None


def test_explicit_import_key_uses_exact_archive_bytes_independently_of_the_path(
    tmp_path: Path,
) -> None:
    package = _package(tmp_path / "package")
    with zipfile.ZipFile(package, "a") as bundle:
        bundle.comment = b"one"
    copied = tmp_path / "copied.advoice.zip"
    shutil.copyfile(package, copied)
    headers = {"Idempotency-Key": "exact-archive"}
    with app_client(tmp_path / "runtime") as client:
        first = client.post(
            "/packages/import",
            json={"path": str(package), "decision": "SafeOnly"},
            headers=headers,
        )
        assert first.status_code == 202, first.text
        job_id = first.json()["jobId"]
        result = wait_for_job(client, job_id)
        assert result["state"] == "Succeeded", result

        repeated = client.post(
            "/packages/import",
            json={"path": str(copied), "decision": "SafeOnly"},
            headers=headers,
        )
        assert repeated.status_code == 202, repeated.text
        assert repeated.json()["jobId"] == job_id

        # Only the ZIP comment changes: it remains a valid package of the same size and mtime.
        original_stat = package.stat()
        contents = package.read_bytes()
        assert contents.endswith(b"one")
        package.write_bytes(contents[:-3] + b"two")
        os.utime(package, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
        assert package.stat().st_size == original_stat.st_size
        assert package.stat().st_mtime_ns == original_stat.st_mtime_ns
        changed = client.post(
            "/packages/import",
            json={"path": str(package), "decision": "SafeOnly"},
            headers=headers,
        )
        assert changed.status_code == 409, changed.text
        assert changed.json()["code"] == "IdempotencyConflict"

        changed_decision = client.post(
            "/packages/import",
            json={"path": str(copied), "decision": "AcceptOlder"},
            headers=headers,
        )
        assert changed_decision.status_code == 409, changed_decision.text
        assert changed_decision.json()["code"] == "IdempotencyConflict"
        with client.app.state.container.database.create() as transaction:
            assert transaction.jobs.count(job_type=JobType.PACKAGE_IMPORT) == 1
