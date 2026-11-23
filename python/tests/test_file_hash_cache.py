import hashlib
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event, current_thread
from unittest.mock import Mock

import pytest

from backend.infrastructure import file_hash_cache
from backend.infrastructure.file_hash_cache import FileHashCache
from backend.infrastructure.hashing import sha256_file


def _clip(tmp_path):
    path = tmp_path / "clip.mp4"
    path.write_bytes(b"original")
    return path


@pytest.mark.parametrize("replace_file", [False, True])
def test_same_size_edits_and_replacements_invalidate_memory_and_disk(
    tmp_path, monkeypatch, replace_file
):
    path = _clip(tmp_path)
    identity = file_hash_cache._identity
    # Windows creation time may stay unchanged; rely on mtime and file identity too.
    monkeypatch.setattr(file_hash_cache, "_identity", lambda p: (*identity(p)[:4], 0))
    root, hasher = tmp_path / "cache", Mock(wraps=sha256_file)
    cache = FileHashCache(root, hasher)
    before, old_time = cache(path), path.stat().st_mtime_ns
    if replace_file:
        replacement = tmp_path / "replacement.mp4"
        replacement.write_bytes(b"modified")
        os.utime(replacement, ns=(old_time, old_time))
        replacement.replace(path)
    else:
        path.write_bytes(b"modified")
        os.utime(path, ns=(old_time + 1_000_000, old_time + 1_000_000))
    after = cache(path)
    assert after != before and after == sha256_file(path)
    assert FileHashCache(root, hasher)(path) == after
    assert hasher.call_count == 2


def test_a_file_changed_during_hashing_is_not_cached(tmp_path):
    path = _clip(tmp_path)
    root = tmp_path / "cache"
    old_time = path.stat().st_mtime_ns

    def changed(source):
        digest = sha256_file(source)
        source.write_bytes(b"modified")
        os.utime(source, ns=(old_time + 1_000_000, old_time + 1_000_000))
        return digest

    first = FileHashCache(root, changed)(path)
    hasher = Mock(wraps=sha256_file)
    after = FileHashCache(root, hasher)(path)
    assert first != after and after == sha256_file(path)
    assert hasher.call_count == 1
    assert FileHashCache(root, hasher)(path) == after
    assert hasher.call_count == 1


@pytest.mark.parametrize(
    "raw",
    [b"{truncated", b"\xff", b"x" * 65537, b'{"version":2}', b'{"version":1,"entries":[]}'],
    ids=[
        "truncated-json",
        "invalid-utf8",
        "oversized-bucket",
        "unknown-version",
        "invalid-entries",
    ],
)
def test_corrupt_or_unknown_cache_data_falls_back_to_real_hash(tmp_path, raw):
    path = _clip(tmp_path)
    root = tmp_path / "cache"
    before = FileHashCache(root, sha256_file)(path)
    next(root.glob("*.json")).write_bytes(raw)
    hasher = Mock(wraps=sha256_file)
    assert FileHashCache(root, hasher)(path) == before
    hasher.assert_called_once_with(path)


@pytest.mark.parametrize("failure", ["read", "write"])
def test_unreadable_or_read_only_cache_does_not_block_the_library(tmp_path, monkeypatch, failure):
    path = _clip(tmp_path)
    root = tmp_path / "cache"
    expected = FileHashCache(root, sha256_file)(path)
    if failure == "read":
        original = Path.open

        def open_file(target, *args, **kwargs):
            if root in target.parents:
                raise PermissionError("Cache is not readable")
            return original(target, *args, **kwargs)

        monkeypatch.setattr(Path, "open", open_file)
    else:
        next(root.glob("*.json")).unlink()
        monkeypatch.setattr(
            file_hash_cache,
            "NamedTemporaryFile",
            Mock(side_effect=PermissionError("Cache is read-only")),
        )
    hasher = Mock(wraps=sha256_file)
    cache = FileHashCache(root, hasher)
    assert cache(path) == cache(path) == expected
    hasher.assert_called_once_with(path)


def test_hash_failure_is_propagated_and_not_remembered(tmp_path):
    path = _clip(tmp_path)
    expected = sha256_file(path)
    hasher = Mock(side_effect=[OSError("Clip unavailable"), expected])
    cache = FileHashCache(tmp_path / "cache", hasher)
    with pytest.raises(OSError, match="Clip unavailable"):
        cache(path)
    assert cache(path) == cache(path) == expected
    assert hasher.call_count == 2


def test_concurrent_duplicate_reads_share_hashing_without_holding_other_clips(tmp_path):
    first = _clip(tmp_path)
    second = tmp_path / "second.mp4"
    second.write_bytes(b"another clip")
    entered, release = Event(), Event()

    def held(path):
        if path == first:
            entered.set()
            assert release.wait(3)
        return sha256_file(path)

    hasher = Mock(side_effect=held)
    cache = FileHashCache(tmp_path / "cache", hasher)
    with ThreadPoolExecutor(max_workers=3) as executor:
        pending = executor.submit(cache, first)
        try:
            assert entered.wait(1)
            duplicate = executor.submit(cache, first)
            assert executor.submit(cache, second).result(timeout=0.3) == sha256_file(second)
            release.set()
            assert pending.result(timeout=1) == duplicate.result(timeout=1) == sha256_file(first)
        finally:
            release.set()
    assert [call.args[0] for call in hasher.call_args_list].count(first) == 1


def _colliding_paths(root, count):
    paths = []
    for index in range(10000):
        path = root / f"clip-{index}.mp4"
        if hashlib.sha256(str(path.absolute()).encode()).hexdigest().startswith("00"):
            path.write_bytes(str(index).encode())
            paths.append(path)
        if len(paths) == count:
            return paths
    raise AssertionError("Could not construct the cache collision fixture")


def test_disk_buckets_and_memory_stay_bounded_after_collisions(tmp_path, monkeypatch):
    monkeypatch.setattr(file_hash_cache, "_BUCKET_ENTRIES", 2)
    monkeypatch.setattr(file_hash_cache, "_MEMORY_ENTRIES", 2)
    paths = _colliding_paths(tmp_path, 3)
    root = tmp_path / "cache"
    cache = FileHashCache(root, sha256_file)
    for path in paths:
        assert cache(path) == sha256_file(path)
    assert len(cache._memory) == 2
    buckets = list(root.glob("*.json"))
    assert len(buckets) == 1
    assert len(json.loads(buckets[0].read_text())["entries"]) == 2
    for path in paths:
        assert FileHashCache(root, sha256_file)(path) == sha256_file(path)


def test_failed_atomic_publication_preserves_other_cached_hashes(tmp_path, monkeypatch):
    first, second = _colliding_paths(tmp_path, 2)
    root = tmp_path / "cache"
    cache = FileHashCache(root, sha256_file)
    expected = cache(first)
    monkeypatch.setattr(os, "replace", Mock(side_effect=OSError("Disk failure")))
    assert cache(second) == sha256_file(second)
    hasher = Mock(wraps=sha256_file)
    assert FileHashCache(root, hasher)(first) == expected
    hasher.assert_not_called()
    assert not list(root.glob("*.tmp"))


class _OverlappingPublication:
    def __init__(self):
        self.original = os.replace
        self.first_ready, self.second_ready, self.release_second = Event(), Event(), Event()

    def replace(self, source, target):
        if current_thread().name.startswith("cache-first"):
            self.first_ready.set()
            assert self.second_ready.wait(3)
        else:
            self.second_ready.set()
            assert self.release_second.wait(3)
        self.original(source, target)


def test_two_cache_instances_cannot_publish_each_others_temporary_files(tmp_path, monkeypatch):
    first, second = _colliding_paths(tmp_path, 2)
    root = tmp_path / "cache"
    gate = _OverlappingPublication()
    monkeypatch.setattr(os, "replace", gate.replace)
    with (
        ThreadPoolExecutor(max_workers=1, thread_name_prefix="cache-first") as first_worker,
        ThreadPoolExecutor(max_workers=1, thread_name_prefix="cache-second") as second_worker,
    ):
        pending = first_worker.submit(FileHashCache(root, sha256_file), first)
        try:
            assert gate.first_ready.wait(1)
            other = second_worker.submit(FileHashCache(root, sha256_file), second)
            assert gate.second_ready.wait(1)
            assert pending.result(timeout=2) == sha256_file(first)
            published = json.loads((root / "00.json").read_text())
            first_key = hashlib.sha256(str(first.absolute()).encode()).hexdigest()
            assert set(published["entries"]) == {first_key}, "Published the other writer's file"
            assert not other.done()
        finally:
            gate.release_second.set()
        assert other.result(timeout=2) == sha256_file(second)
    assert not list(root.glob("*.tmp"))
