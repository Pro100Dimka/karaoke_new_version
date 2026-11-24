from __future__ import annotations

import os
import threading
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import Mock

import pytest

from backend.processing.job_manager import JobContext
from backend.projects.operations import SongOperation
from tests.conftest import app_client, write_wav
from tests.helpers import import_song, wait_for_job
from tests.test_library_archive import transfer

pytestmark = pytest.mark.integration


@pytest.fixture
def library_backup(tmp_path):
    source = tmp_path / "source.wav"
    write_wav(source, seconds=0.1)
    with app_client(tmp_path / "source-library") as client:
        song = import_song(client, source)
        media = client.app.state.container.roots.songs / song["songId"] / "large-media.bin"
        payload = os.urandom(4 * 1024 * 1024 + 17)
        media.write_bytes(payload)
        backup = Path(transfer(client, "export")["path"])
        yield client, song["songId"], media, payload, backup


@pytest.mark.parametrize("action", ["export", "import"])
def test_library_cancellation_stops_hashing_between_chunks_before_publication(
    library_backup, tmp_path, monkeypatch, action
):
    source_client, song_id, source_media, payload, backup = library_backup
    target = (
        nullcontext(source_client)
        if action == "export"
        else app_client(tmp_path / "target-library")
    )
    with target as client:
        library = client.app.state.container.packages.library
        roots = client.app.state.container.roots
        before = client.get("/songs").json()["items"]
        build = Mock(wraps=library._archive.build)
        restore = Mock(wraps=library._library.restore)
        monkeypatch.setattr(library._archive, "build", build)
        monkeypatch.setattr(library._library, "restore", restore)
        hash_file = library._hasher
        open_file = Path.open
        entered, release = threading.Event(), threading.Event()
        reads, handles = [], []
        hashing_path = None

        class HeldReader:
            def __init__(self, stream):
                self.stream = stream

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                self.stream.close()

            def read(self, size):
                chunk = self.stream.read(size)
                reads.append(len(chunk))
                if len(reads) == 1:
                    entered.set()
                    assert release.wait(10), "Cancellation did not release the first checksum read"
                return chunk

        def observe_open(path, mode="r", *args, **kwargs):
            stream = open_file(path, mode, *args, **kwargs)
            if path == hashing_path and mode == "rb":
                handles.append(stream)
                return HeldReader(stream)
            return stream

        def observe_hash(path, checkpoint=None):
            nonlocal hashing_path
            hashing_path = path if path.name == source_media.name else None
            try:
                return hash_file(path, checkpoint)
            finally:
                hashing_path = None

        monkeypatch.setattr(library, "_hasher", observe_hash)
        with monkeypatch.context() as read_patch:
            read_patch.setattr(Path, "open", observe_open)
            started = client.post(
                f"/packages/library/{action}",
                json={"path": str(backup)} if action == "import" else None,
            )
            assert started.status_code == 202, started.text
            job_id = started.json()["jobId"]
            try:
                assert entered.wait(10), "The library job did not begin hashing its large file"
                cancelled = client.post(f"/jobs/{job_id}/cancel")
                assert cancelled.status_code == 200, cancelled.text
                assert cancelled.json()["state"] == "Cancelling"
                assert reads == [1024 * 1024]
            finally:
                release.set()
            result = wait_for_job(client, job_id)

        assert result["state"] == "Cancelled", result
        assert handles and all(stream.closed for stream in handles)
        assert not tuple(roots.temp.glob("library-*"))
        assert client.get("/songs").json()["items"] == before
        assert source_media.read_bytes() == payload
        assert backup.is_file()
        build.assert_not_called()
        restore.assert_not_called()
        with library._operations.acquire(song_id, SongOperation.PACKAGE_IMPORT):
            pass
        print(
            f"library_{action}_checksum_reads={len(reads)} "
            f"bytes_read={sum(reads)} total_bytes={len(payload)}"
        )
        assert reads == [1024 * 1024], "Cancellation read the remaining library file"


def test_library_import_does_not_add_a_cancellation_checkpoint_after_restore(
    library_backup, tmp_path, monkeypatch
):
    _, song_id, source_media, payload, backup = library_backup
    with app_client(tmp_path / "target-library") as client:
        library = client.app.state.container.packages.library
        restore = library._library.restore
        cancel = threading.Event()

        def restore_then_cancel(data, workspace):
            result = restore(data, workspace)
            cancel.set()
            return result

        monkeypatch.setattr(library._library, "restore", restore_then_cancel)
        context = JobContext("restore-boundary", cancel, lambda *_args: None)
        result = library._run("import", backup, context)

        assert cancel.is_set()
        assert result["imported"] == 1
        roots = client.app.state.container.roots
        assert client.get(f"/songs/{song_id}").status_code == 200
        assert (roots.songs / song_id / source_media.name).read_bytes() == payload
        assert not tuple(roots.temp.glob("library-*"))
