from __future__ import annotations

import builtins
import hashlib
import json
from contextlib import contextmanager
from pathlib import Path
import sqlite3
from threading import Event
import zipfile

import pytest

from tests.conftest import app_client
from tests.helpers import wait_for_job
from tests.test_package_covers import SONG_ID, _import, _package


@pytest.mark.parametrize("phase", ["snapshot", "hash", "validation"])
def test_export_cancellation_stops_large_file_reads_and_preserves_published_output(
    tmp_path, monkeypatch, phase
):
    payload = b"\x00\x00\x00\x18ftyp" + b"x" * (4 * 1024 * 1024 + 17)
    clip = tmp_path / "selected.mp4"
    clip.write_bytes(payload)
    runtime = tmp_path / "runtime"
    with app_client(runtime) as client:
        _import(client, _package(tmp_path / "incoming"))
        selected = client.patch(f"/songs/{SONG_ID}", json={"videoPath": str(clip)})
        assert selected.status_code == 200, selected.text
        exporter = client.app.state.container.packages.start_export._export
        source = exporter._snapshot._projects.video_path(SONG_ID, 1, prefer_local=True)
        output = exporter._outputs.path_for_export(SONG_ID, 1)
        with zipfile.ZipFile(output, "w") as previous:
            previous.writestr("previous-export.txt", b"previous verified export")
        previous_bytes = output.read_bytes()
        entered, release = Event(), Event()
        reads, streams, media_lock = [], [], []
        path_open, builtin_open, zip_read = Path.open, builtins.open, zipfile.ZipExtFile.read
        media_update = exporter._snapshot._songs.media_update

        def observe(count):
            reads.append(count)
            if len(reads) == 1:
                entered.set()
                assert release.wait(10), "Export cancellation did not release the current read"

        class Reader:
            def __init__(self, stream):
                self.stream = stream

            def __enter__(self):
                return self

            def __exit__(self, *args):
                self.stream.close()

            def __getattr__(self, name):
                # Make the old native copy use its stream fallback so reads are observable.
                if name == "fileno":
                    raise AttributeError(name)
                return getattr(self.stream, name)

            def read(self, size=-1):
                chunk = self.stream.read(size)
                observe(len(chunk))
                return chunk

            def readinto(self, buffer):
                count = self.stream.readinto(buffer)
                observe(count)
                return count

        def tracked(path, mode, stream):
            if mode == "rb" and isinstance(path, (str, Path)):
                candidate = Path(path)
                watched = (
                    candidate == source
                    if phase == "snapshot"
                    else (
                        phase == "hash"
                        and candidate.name == "clip.mp4"
                        and candidate.is_relative_to(runtime / "temp")
                    )
                )
                if watched:
                    streams.append(stream)
                    return Reader(stream)
            return stream

        def open_path(path, mode="r", *args, **kwargs):
            return tracked(path, mode, path_open(path, mode, *args, **kwargs))

        def open_builtin(path, mode="r", *args, **kwargs):
            return tracked(path, mode, builtin_open(path, mode, *args, **kwargs))

        def read_zip(stream, size=-1):
            chunk = zip_read(stream, size)
            if phase == "validation" and stream.name == "media/clip.mp4":
                if stream not in streams:
                    streams.append(stream)
                observe(len(chunk))
            return chunk

        @contextmanager
        def track_media(song_id):
            try:
                with media_update(song_id) as update:
                    media_lock.append("acquired")
                    yield update
            finally:
                media_lock.append("released")

        with monkeypatch.context() as hooks:
            hooks.setattr(Path, "open", open_path)
            hooks.setattr(builtins, "open", open_builtin)
            hooks.setattr(zipfile.ZipExtFile, "read", read_zip)
            hooks.setattr(exporter._snapshot._songs, "media_update", track_media)
            started = client.post(f"/packages/export/{SONG_ID}")
            assert started.status_code == 202, started.text
            try:
                assert entered.wait(10), f"Export did not reach {phase} reads"
                cancelled = client.post(f"/jobs/{started.json()['jobId']}/cancel")
                assert cancelled.status_code == 200, cancelled.text
                assert cancelled.json()["state"] == "Cancelling"
            finally:
                release.set()
            result = wait_for_job(client, started.json()["jobId"])
        assert result["state"] == "Cancelled", result
        assert output.read_bytes() == previous_bytes
        assert source.read_bytes() == payload
        assert not list(output.parent.glob(".*.tmp"))
        assert not list((runtime / "temp").glob(f"export-{SONG_ID}-*"))
        assert exporter._operations.active(SONG_ID) is None
        assert media_lock == ["acquired", "released"]
        assert streams and all(stream.closed for stream in streams)
        with sqlite3.connect(runtime / "app.db") as database:
            assert (
                database.execute(
                    "SELECT count(*) FROM history_events WHERE event_type='PackageExported'"
                ).fetchone()[0]
                == 0
            )
        print(
            f"phase={phase} reads={len(reads)} bytes_read={sum(reads)} bytes_total={len(payload)}"
        )
        assert len(reads) == 1 and 0 < reads[0] <= 1024 * 1024
        retried = client.post(f"/packages/export/{SONG_ID}")
        completed = wait_for_job(client, retried.json()["jobId"])
        assert completed["state"] == "Succeeded", completed
        with zipfile.ZipFile(output) as archive:
            assert archive.read("media/clip.mp4") == payload
            manifest = json.loads(archive.read("package.json"))
            for artifact in manifest["artifacts"]:
                expected = artifact["checksum"]
                assert hashlib.sha256(archive.read(artifact["path"])).hexdigest() == expected
