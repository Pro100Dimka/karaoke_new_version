from __future__ import annotations

import threading
from pathlib import Path

import pytest

from backend.processing.job_manager import JobContext
from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.helpers import import_song, wait_for_job

pytestmark = pytest.mark.integration


@pytest.fixture
def snapshot_library(tmp_path: Path):
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song = import_song(client, source)
        managed = client.app.state.container.songs.get_song.execute(song["songId"]).source_path
        yield client, managed, source.read_bytes()


def _assert_preserved_and_clean(client, managed: Path, expected: bytes) -> None:
    roots = client.app.state.container.roots
    assert managed.read_bytes() == expected
    assert not tuple(roots.temp.glob("library-*"))
    assert not tuple((roots.app / "exports").glob("*"))
    assert client.get("/songs").json()["items"]


def test_library_snapshot_progress_does_not_restart_during_hashing(snapshot_library) -> None:
    client, _, _ = snapshot_library
    updates: list[tuple[str, float, float]] = []
    context = JobContext(
        "snapshot-progress",
        threading.Event(),
        lambda stage, part, total: updates.append((stage, part, total)),
    )
    client.app.state.container.packages.library._run("export", None, context)
    snapshot = [(part, total) for stage, part, total in updates if stage == "Snapshot"]
    assert snapshot[-1] == pytest.approx((1.0, 0.15))
    assert [part for part, _ in snapshot] == sorted(part for part, _ in snapshot)
    assert [total for _, total in snapshot] == sorted(total for _, total in snapshot)


def test_cancellation_during_library_snapshot_preserves_source_and_cleans_workspace(
    snapshot_library, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, managed, expected = snapshot_library
    storage = client.app.state.container.packages.library._library
    snapshot = storage.snapshot
    entered, release = threading.Event(), threading.Event()

    def blocked_snapshot(song_ids, destination, progress):
        def checkpoint(fraction: float) -> None:
            if fraction > 0 and not entered.is_set():
                entered.set()
                assert release.wait(10), "Snapshot cancellation was not requested"
            progress(fraction)

        return snapshot(song_ids, destination, checkpoint)

    monkeypatch.setattr(storage, "snapshot", blocked_snapshot)
    started = client.post("/packages/library/export")
    assert started.status_code == 202, started.text
    try:
        assert entered.wait(10), "Library snapshot did not start copying"
        cancelled = client.post(f"/jobs/{started.json()['jobId']}/cancel")
        assert cancelled.status_code == 200, cancelled.text
    finally:
        release.set()
    result = wait_for_job(client, started.json()["jobId"])
    assert result["state"] == "Cancelled", result
    _assert_preserved_and_clean(client, managed, expected)


def test_library_snapshot_write_failure_preserves_source_and_cleans_workspace(
    snapshot_library, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, managed, expected = snapshot_library
    temporary = client.app.state.container.roots.temp
    open_file = Path.open

    def fail_snapshot_write(path: Path, mode="r", *args, **kwargs):
        if mode == "wb" and path.is_relative_to(temporary):
            with open_file(path, mode, *args, **kwargs) as output:
                output.write(b"partial snapshot")
            raise OSError("Injected snapshot disk failure")
        return open_file(path, mode, *args, **kwargs)

    monkeypatch.setattr(Path, "open", fail_snapshot_write)
    started = client.post("/packages/library/export")
    assert started.status_code == 202, started.text
    result = wait_for_job(client, started.json()["jobId"])
    assert result["state"] == "Failed", result
    assert result["error"]["code"] == "StorageUnavailable"
    _assert_preserved_and_clean(client, managed, expected)


def test_library_export_reserves_space_for_snapshot_and_archive(
    snapshot_library, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, managed, expected = snapshot_library
    roots = client.app.state.container.roots
    library = client.app.state.container.packages.library._library
    file_bytes = sum(path.stat().st_size for path in roots.songs.rglob("*") if path.is_file())
    monkeypatch.setattr(library._storage, "free_bytes", lambda _: library._margin + file_bytes)
    started = client.post("/packages/library/export")
    assert started.status_code == 202, started.text
    result = wait_for_job(client, started.json()["jobId"])
    assert result["state"] == "Failed", result
    assert result["error"]["code"] == "InsufficientDiskSpace"
    assert result["error"]["details"]["requiredBytes"] == library._margin + 2 * file_bytes
    _assert_preserved_and_clean(client, managed, expected)
