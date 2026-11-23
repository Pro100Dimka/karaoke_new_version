from __future__ import annotations

import os
import shutil
from datetime import UTC, datetime
from pathlib import Path
from threading import Event
from types import SimpleNamespace

import pytest

from backend.infrastructure.local_storage import LocalStorageSystem, _tree_size
from backend.processing.domain import JobType
from backend.storage.domain import StorageRoots
from tests.helpers import wait_for_job

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def isolated_models(monkeypatch):
    monkeypatch.delenv("AD_VOICE_MODELS", raising=False)


def _entry(root: Path, name: str = "working") -> tuple[Path, Path]:
    directory = root / name
    directory.mkdir(parents=True)
    content = directory / "chunk.bin"
    content.write_bytes(b"active work must survive cleanup")
    os.utime(directory, (1, 1))
    return directory, content


def _user_files(container) -> dict[Path, bytes]:
    files = {}
    for root in (container.roots.songs, container.roots.recordings, container.roots.models):
        path = root / "keep.bin"
        path.write_bytes(b"owned user data")
        files[path] = path.read_bytes()
    return files


@pytest.mark.parametrize("area", ["cache", "temp"])
@pytest.mark.parametrize("cancel", [False, True])
def test_manual_cleanup_preserves_files_owned_by_running_or_cancelling_jobs(client, area, cancel):
    container = client.app.state.container
    directory, content = _entry(getattr(container.roots, area))
    preserved = _user_files(container)
    entered, release = Event(), Event()

    def worker(context):
        entered.set()
        assert release.wait(5), "The cleanup request did not return"
        assert content.read_bytes() == b"active work must survive cleanup"
        context.ensure_not_cancelled()
        return {"read": True}

    job = container.system.jobs.start(JobType.SONG_PROCESSING, worker, entity_id="cleanup-fixture")
    try:
        assert entered.wait(5), "The worker did not acquire its files"
        if cancel:
            assert client.post(f"/jobs/{job.job_id}/cancel").status_code == 200
        response = client.post(f"/storage/{area}/clear")
    finally:
        release.set()
    completed = wait_for_job(client, job.job_id)
    assert response.status_code == 409, response.text
    assert response.json()["code"] == "StorageInUse"
    assert completed["state"] == ("Cancelled" if cancel else "Succeeded"), completed
    assert content.is_file()
    retried = client.post(f"/storage/{area}/clear")
    assert retried.status_code == 200, retried.text
    assert retried.json()["removed"] >= 1
    assert not directory.exists()
    assert {path: path.read_bytes() for path in preserved} == preserved


@pytest.mark.parametrize("area", ["cache", "temp"])
def test_cleanup_cannot_remove_inputs_before_a_job_has_been_submitted(client, area):
    container = client.app.state.container
    directory, content = _entry(getattr(container.roots, area))
    with container.system.jobs.prepare_submission():
        response = client.post(f"/storage/{area}/clear")
    assert response.status_code == 409, response.text
    assert response.json()["code"] == "StorageInUse"
    assert content.read_bytes() == b"active work must survive cleanup"
    assert client.post(f"/storage/{area}/clear").status_code == 200
    assert not directory.exists()


def _deny_directory(monkeypatch, directory):
    remove = shutil.rmtree

    def denied(path, *args, **kwargs):
        if Path(path) == directory:
            if kwargs.get("ignore_errors") or (args and args[0]):
                return
            raise PermissionError("Directory is currently in use")
        return remove(path, *args, **kwargs)

    monkeypatch.setattr(shutil, "rmtree", denied)


@pytest.mark.parametrize("area", ["cache", "temp"])
@pytest.mark.parametrize("entry_type", ["directory", "file"])
def test_manual_cleanup_reports_locked_files_instead_of_claiming_success(
    client,
    monkeypatch,
    area,
    entry_type,
):
    container = client.app.state.container
    root = getattr(container.roots, area)
    preserved = _user_files(container)
    if entry_type == "directory":
        target, content = _entry(root, "locked")
        _deny_directory(monkeypatch, target)
    else:
        target = content = root / "locked.bin"
        content.write_bytes(b"locked work")
        os.utime(target, (1, 1))
        unlink = Path.unlink

        def denied(path, *args, **kwargs):
            if path == target:
                raise PermissionError("File is currently in use")
            return unlink(path, *args, **kwargs)

        monkeypatch.setattr(Path, "unlink", denied)
    before = content.read_bytes()
    response = client.post(f"/storage/{area}/clear")
    assert response.status_code == 503, response.text
    failure = response.json()
    assert failure["code"] == "StorageUnavailable"
    assert failure["details"]["path"] == str(target)
    assert failure["details"]["removed"] >= 0
    assert content.read_bytes() == before
    assert {path: path.read_bytes() for path in preserved} == preserved


def test_startup_temp_cleanup_counts_only_removed_entries_and_can_defer_locked_files(
    tmp_path,
    monkeypatch,
):
    roots = StorageRoots.under(tmp_path / "profile")
    locked, content = _entry(roots.temp, "locked")
    removable = roots.temp / "expired.bin"
    removable.write_bytes(b"expired")
    os.utime(removable, (1, 1))
    _deny_directory(monkeypatch, locked)
    storage = LocalStorageSystem(roots, SimpleNamespace(now=lambda: datetime.now(UTC)))
    assert storage.cleanup_temp(24 * 60 * 60) == 1
    assert content.is_file()
    assert not removable.exists()


def test_storage_usage_survives_a_file_removed_between_listing_and_size_read(tmp_path, monkeypatch):
    disappearing = tmp_path / "finishing-job.bin"
    kept = tmp_path / "kept.bin"
    disappearing.write_bytes(b"already consumed")
    kept.write_bytes(b"remaining data")
    scan = os.scandir

    class Entry:
        def __init__(self, actual):
            self.actual = actual
            self.path = actual.path

        def is_dir(self, **kwargs):
            return self.actual.is_dir(**kwargs)

        def is_file(self):
            present = self.actual.is_file()
            if Path(self.path) == disappearing:
                disappearing.unlink()
            return present

        def stat(self):
            return os.stat(self.path)

    class Directory:
        def __init__(self, path):
            self.entries = scan(path)

        def __enter__(self):
            self.entries.__enter__()
            return self

        def __exit__(self, *args):
            return self.entries.__exit__(*args)

        def __iter__(self):
            return (Entry(entry) for entry in self.entries)

    with monkeypatch.context() as patch:
        patch.setattr(os, "scandir", Directory)
        size = _tree_size(tmp_path)
    assert size == kept.stat().st_size
    assert not disappearing.exists()
