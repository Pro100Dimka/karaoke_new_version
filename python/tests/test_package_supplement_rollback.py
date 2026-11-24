from __future__ import annotations

import builtins
import errno
import hashlib
import io
import json
import os
from contextlib import contextmanager
from pathlib import Path

import pytest
from sqlalchemy.exc import SQLAlchemyError

import backend.infrastructure.song_media_updates as media_storage
from backend.domain_errors import ConflictError, DomainError
from backend.infrastructure.sql_songs import SqlSongRepository
from tests.test_package_covers import (
    INCOMING_COVER,
    LOCAL_COVER,
    SONG_ID,
    _files,
    _import,
    _package,
    _song,
    _write_zip,
)

pytestmark = pytest.mark.integration
_CHUNK = 1024 * 1024
_OLD = b"original-revision-video"
_NEW = b"incoming-revision-video"
_LARGE = b"large-video-data\0" * (3 * _CHUNK // 17 + 1)


def _clip_package(root: Path, clip: bytes | None, cover: bytes | None = None) -> Path:
    package = _package(root, cover=cover)
    if clip is None:
        return package
    files = _files(package)
    files["media/clip.mp4"] = clip
    manifest = json.loads(files["package.json"])
    manifest["songIdentity"]["videoUrl"] = "local:clip"
    manifest["artifacts"].append(
        {"path": "media/clip.mp4", "checksum": hashlib.sha256(clip).hexdigest()}
    )
    files["package.json"] = json.dumps(manifest).encode()
    _write_zip(package, files)
    return package


def _prepare(client, tmp_path, old=_OLD, incoming=_NEW):
    # An existing custom cover also proves that clip rollback does not depend on a cover installer.
    seed = _clip_package(tmp_path / "seed", old, LOCAL_COVER if old is not None else None)
    _import(client, seed)
    package = _clip_package(tmp_path / "incoming", incoming, INCOMING_COVER)
    importer = client.app.state.container.packages.start_import._import
    target = client.app.state.container.roots.songs / SONG_ID / "revisions/1/media/clip.mp4"
    return importer, package, target, _song(client)


def _assert_clean(client, target):
    roots = client.app.state.container.roots
    assert not list(roots.temp.glob(f"supplement-{SONG_ID}-*"))
    assert not list(target.parent.glob("*.backup"))
    assert not target.with_name(".clip.mp4.importing").exists()
    assert (
        not client.app.state.container.packages.start_import._import._publication._journal.entries()
    )


def _assert_retained(client, target, before, old):
    assert _song(client) == before
    if old is None:
        assert not target.exists()
        assert not list((target.parents[3] / "cover").glob("*"))
    else:
        assert target.read_bytes() == old
        assert before.cover_path.read_bytes() == LOCAL_COVER
    _assert_clean(client, target)


def _cancelled():
    raise ConflictError("JobCancelled", "Package import was cancelled")


@pytest.mark.parametrize("old", [None, _OLD], ids=["missing-clip", "existing-clip"])
@pytest.mark.parametrize("failure", ["cancellation", "database"])
def test_supplement_rolls_back_clip_after_publication(client, tmp_path, monkeypatch, old, failure):
    importer, package, target, before = _prepare(client, tmp_path, old)
    storage = importer._publication._projects
    install = storage.install_revision_artifact
    installed = False

    def observe_install(*args, **kwargs):
        nonlocal installed
        install(*args, **kwargs)
        assert target.read_bytes() == _NEW
        installed = True

    def checkpoint():
        if installed and failure == "cancellation":
            _cancelled()

    monkeypatch.setattr(storage, "install_revision_artifact", observe_install)
    if failure == "database":

        def reject_update(*_args):
            raise SQLAlchemyError("Simulated supplement catalog failure")

        monkeypatch.setattr(SqlSongRepository, "update", reject_update)
    with pytest.raises(DomainError) as error:
        importer.execute(package, ensure_not_cancelled=checkpoint)
    assert installed
    assert error.value.code == (
        "JobCancelled" if failure == "cancellation" else "DatabaseReadFailed"
    )
    _assert_retained(client, target, before, old)


@contextmanager
def _observed_reads(monkeypatch, predicate, observe):
    open_file = builtins.open

    class ReadProbe:
        def __init__(self, stream):
            self.stream = stream
            self.buffers = []

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return self.stream.__exit__(*args)

        def __getattr__(self, name):
            return getattr(self.stream, name)

        def fileno(self):
            # Exercise shutil's portable streaming path as well as the cancellable reader.
            raise OSError(errno.ENOTSUP, "Instrumented stream has no file descriptor")

        def read(self, size=-1):
            data = self.stream.read(size)
            observe(len(data), size, None)
            return data

        def readinto(self, buffer):
            # Keep references so an allocation per chunk cannot pass through recycled ids.
            self.buffers.append(buffer)
            count = self.stream.readinto(buffer)
            observe(count, len(buffer), id(buffer))
            return count

    def observed_open(file, mode="r", *args, **kwargs):
        stream = open_file(file, mode, *args, **kwargs)
        if "r" in mode and not isinstance(file, int) and predicate(Path(file)):
            return ReadProbe(stream)
        return stream

    with monkeypatch.context() as hooks:
        hooks.setattr(builtins, "open", observed_open)
        hooks.setattr(io, "open", observed_open)
        yield


def test_successful_supplement_links_old_clip_and_reuses_one_incoming_buffer(
    client, tmp_path, monkeypatch
):
    importer, package, target, _before = _prepare(client, tmp_path, incoming=_LARGE)
    storage = importer._publication._projects
    install = storage.install_revision_artifact
    link, replace = os.link, os.replace
    old_identity = target.stat().st_ino
    links, reads, old_reads = [], [], []
    installing = False

    def observe_install(*args, **kwargs):
        nonlocal installing
        installing = True
        try:
            return install(*args, **kwargs)
        finally:
            installing = False

    def observe_link(source, destination, *args, **kwargs):
        result = link(source, destination, *args, **kwargs)
        if Path(source) == target:
            assert target.samefile(destination)
            links.append(Path(destination))
        return result

    def observe_replace(source, destination):
        if Path(destination) == target:
            assert target.stat().st_ino == old_identity, "Old clip must remain until atomic replace"
        return replace(source, destination)

    def selected(path):
        if path == target:
            old_reads.append(path)
        return installing and path.name == "clip.mp4" and path != target

    monkeypatch.setattr(storage, "install_revision_artifact", observe_install)
    monkeypatch.setattr(os, "link", observe_link)
    monkeypatch.setattr(os, "replace", observe_replace)
    with _observed_reads(monkeypatch, selected, lambda *entry: reads.append(entry)):
        result = importer.execute(package, ensure_not_cancelled=lambda: None)
    assert result.created is False
    assert len(links) == 1 and not old_reads, "Backing up an immutable clip must not reread it"
    assert sum(count for count, _, _ in reads) == len(_LARGE)
    assert {size for _, size, _ in reads} == {_CHUNK}
    assert None not in {buffer for _, _, buffer in reads}
    assert len({buffer for _, _, buffer in reads}) == 1
    assert target.read_bytes() == _LARGE
    _assert_clean(client, target)


@pytest.mark.parametrize("stage", ["incoming-copy", "backup-copy"])
def test_supplement_copy_cancellation_stops_before_next_chunk(client, tmp_path, monkeypatch, stage):
    old = _LARGE if stage == "backup-copy" else _OLD
    incoming = _LARGE if stage == "incoming-copy" else _NEW
    importer, package, target, before = _prepare(client, tmp_path, old, incoming)
    storage = importer._publication._projects
    install, link = storage.install_revision_artifact, os.link
    installing, cancelled = False, False
    consumed = 0

    def observe_install(*args, **kwargs):
        nonlocal installing
        installing = True
        try:
            return install(*args, **kwargs)
        finally:
            installing = False

    def unavailable_link(source, destination, *args, **kwargs):
        if Path(source) == target:
            raise OSError(errno.ENOTSUP, "This file system cannot create hard links")
        return link(source, destination, *args, **kwargs)

    def checkpoint():
        if cancelled:
            _cancelled()

    def observe(count, _size, _buffer):
        nonlocal consumed, cancelled
        consumed += count
        cancelled = cancelled or count > 0

    def selected(path):
        if stage == "backup-copy":
            return path == target
        return installing and path.name == "clip.mp4" and path != target

    monkeypatch.setattr(storage, "install_revision_artifact", observe_install)
    monkeypatch.setattr(os, "link", unavailable_link)
    with _observed_reads(monkeypatch, selected, observe):
        with pytest.raises(ConflictError) as error:
            importer.execute(package, ensure_not_cancelled=checkpoint)
    assert error.value.code == "JobCancelled"
    assert consumed == _CHUNK, "Cancellation must stop before the next copy chunk"
    _assert_retained(client, target, before, old)


def test_supplement_checks_cancellation_between_backup_and_replace(client, tmp_path, monkeypatch):
    importer, package, target, before = _prepare(client, tmp_path)
    link = os.link
    cancelled = False

    def backup_then_cancel(source, destination, *args, **kwargs):
        nonlocal cancelled
        result = link(source, destination, *args, **kwargs)
        if Path(source) == target:
            cancelled = True
        return result

    def checkpoint():
        if cancelled:
            _cancelled()

    monkeypatch.setattr(os, "link", backup_then_cancel)
    with pytest.raises(ConflictError, match="cancelled"):
        importer.execute(package, ensure_not_cancelled=checkpoint)
    _assert_retained(client, target, before, _OLD)


def test_supplement_tracks_backup_before_temporary_file_close(client, tmp_path, monkeypatch):
    importer, package, target, before = _prepare(client, tmp_path)
    temporary_file = media_storage.NamedTemporaryFile

    @contextmanager
    def failed_close(*args, **kwargs):
        with temporary_file(*args, **kwargs) as output:
            yield output
        raise OSError("Could not close the reserved backup")

    monkeypatch.setattr(media_storage, "NamedTemporaryFile", failed_close)
    with pytest.raises(DomainError) as error:
        importer.execute(package)
    assert error.value.code == "StorageUnavailable"
    _assert_retained(client, target, before, _OLD)


def test_supplement_fallback_restores_a_complete_backup_with_one_reusable_buffer(
    client, tmp_path, monkeypatch
):
    importer, package, target, before = _prepare(client, tmp_path, old=_LARGE)
    storage = importer._publication._projects
    install, link = storage.install_revision_artifact, os.link
    installed = False
    reads = []

    def observe_install(*args, **kwargs):
        nonlocal installed
        install(*args, **kwargs)
        installed = True

    def unavailable_link(source, destination, *args, **kwargs):
        if Path(source) == target:
            raise OSError(errno.ENOTSUP, "This file system cannot create hard links")
        return link(source, destination, *args, **kwargs)

    def checkpoint():
        if installed:
            _cancelled()

    monkeypatch.setattr(storage, "install_revision_artifact", observe_install)
    monkeypatch.setattr(os, "link", unavailable_link)
    with _observed_reads(monkeypatch, lambda path: path == target, lambda *row: reads.append(row)):
        with pytest.raises(ConflictError, match="cancelled"):
            importer.execute(package, ensure_not_cancelled=checkpoint)
    assert sum(count for count, _, _ in reads) == len(_LARGE)
    assert {size for _, size, _ in reads} == {_CHUNK}
    assert None not in {buffer for _, _, buffer in reads}
    assert len({buffer for _, _, buffer in reads}) == 1
    _assert_retained(client, target, before, _LARGE)


@pytest.mark.parametrize("restore", ["newer-file", "blocked-restore"])
def test_supplement_rollback_preserves_newer_file_or_unrestored_backup(
    client, tmp_path, monkeypatch, caplog, restore
):
    importer, package, target, before = _prepare(client, tmp_path)
    storage = importer._publication._projects
    install, replace = storage.install_revision_artifact, os.replace
    external = tmp_path / "newer.mp4"
    external.write_bytes(b"newer-independent-publication")
    installed = False

    def observe_install(*args, **kwargs):
        nonlocal installed
        install(*args, **kwargs)
        if restore == "newer-file":
            replace(external, target)
        installed = True

    def block_restore(source, destination):
        if Path(source).suffix == ".backup" and Path(destination) == target:
            raise PermissionError("Revision video is in use")
        return replace(source, destination)

    def checkpoint():
        if installed:
            _cancelled()

    monkeypatch.setattr(storage, "install_revision_artifact", observe_install)
    if restore == "blocked-restore":
        monkeypatch.setattr(os, "replace", block_restore)
    with pytest.raises(ConflictError) as error:
        importer.execute(package, ensure_not_cancelled=checkpoint)
    assert error.value.code == "JobCancelled"
    assert _song(client) == before
    if restore == "newer-file":
        assert target.read_bytes() == b"newer-independent-publication"
        _assert_clean(client, target)
    else:
        assert target.read_bytes() == _NEW
        backups = list(target.parent.glob("*.backup"))
        assert len(backups) == 1 and backups[0].read_bytes() == _OLD
        assert "Could not restore song media" in caplog.text
