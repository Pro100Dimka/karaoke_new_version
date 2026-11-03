from __future__ import annotations
import os
import shutil
import sqlite3
import sys
import time
from contextlib import ExitStack, closing
from pathlib import Path
from typing import Sequence
from backend.infrastructure.atomic_files import atomic_write_text
from backend.infrastructure.database import Database
from backend.infrastructure.process_runner import ProcessHandle, start_handoff
from backend.infrastructure.hashing import sha256_file
from backend.infrastructure.ids import UuidGenerator
from backend.infrastructure.instance_lock import BackendInstanceLock, _process_exists
from backend.serialization import dumps, loads_object

from backend.infrastructure.profile_progress import (
    _report as _report,
    close_progress as close_progress,
)
from backend.infrastructure.profile_paths import (
    _IMMUTABLE_MEDIA as _IMMUTABLE_MEDIA,
    _LOCK_FILES as _LOCK_FILES,
    _files as _files,
    _path as _path,
    _records as _records,
)


def _verify_sources(state: dict[str, object], marker: Path) -> None:
    _report("Verify")
    cleanup = _records(state, "cleanup")
    inventory = loads_object(marker.with_name(".storage-files.json").read_text(encoding="utf-8"))
    entries = _records(inventory, "files")
    _verify_source_inventory(cleanup, entries, state)
    for index, raw in enumerate(entries):
        _report("Verify", index, len(entries), _path(raw, "source").name)
        file = _path(raw, "source")
        for item in cleanup:
            source, target, backup = (_path(item, key) for key in ("source", "target", "backup"))
            if not file.is_relative_to(source):
                continue
            if item.get("phase") == "linked":
                break
            if backup.is_dir():
                file = backup / file.relative_to(source)
            elif source.exists() and source.resolve() == target.resolve():
                break
            if not file.is_file() or sha256_file(file) != raw["sha256"]:
                raise ValueError(f"Legacy data changed after copying; it was preserved: {file}")
            break
    _report("Verify", len(entries), len(entries))


def _validate_destination(state: dict[str, object], marker: Path) -> None:
    _report("Verify")
    root = marker.parent.resolve()
    identities = state.get("identities")
    if not isinstance(identities, dict):
        raise ValueError("Migration catalog identities are missing")
    _verify_destination_libraries(state, root, identities)
    inventory = loads_object(marker.with_name(".storage-files.json").read_text(encoding="utf-8"))
    for item in _records(inventory, "files"):
        file = _path(item, "target")
        if file.suffix.casefold() not in _IMMUTABLE_MEDIA or any(
            part.casefold() in {"temp", "tmp", "cache", "updates"} for part in file.parts
        ):
            continue
        if not file.is_relative_to(root):
            raise ValueError("Migrated media points outside the installation")
        info = file.stat()
        if info.st_size != item.get("size") or info.st_mtime_ns != item.get("mtime"):
            if sha256_file(file) != item.get("sha256"):
                raise ValueError(f"Migrated media changed before legacy cleanup: {file}")


def _finish(
    state: dict[str, object],
    marker: Path,
    source_locks: Sequence[BackendInstanceLock] = (),
    wait_parent: int = 0,
) -> None:
    with ExitStack() as stack:
        locks = list(source_locks)
        seen: set[Path] = {_path(item, "target").resolve() for item in _records(state, "libraries")}
        _validate_destination(state, marker)
        for item in _records(state, "libraries"):
            folder = _path(item, "source")
            if source_locks or not folder.is_dir() or folder.resolve() in seen:
                continue
            seen.add(folder.resolve())
            lock = BackendInstanceLock(folder / "backend.lock", adopt_marker=True)
            lock.acquire()
            stack.callback(lock.release)
            locks.append(lock)
        _report("Waiting")
        while wait_parent > 0 and _process_exists(wait_parent):
            time.sleep(0.25)
        _verify_sources(state, marker)
        for lock in locks:
            # The live worker's marker keeps older backends out while Windows directory handles close.
            lock.release(preserve_marker=True)
        deadline = time.monotonic() + 10
        while True:
            try:
                _remove_sources(state, marker)
                break
            except OSError as exc:
                if getattr(exc, "winerror", 0) not in {5, 32, 33} or time.monotonic() >= deadline:
                    raise
                time.sleep(0.25)


def _remove_sources(state: dict[str, object], marker: Path) -> None:
    cleanup = _records(state, "cleanup")
    for index, raw in enumerate(cleanup):
        _report("Cleanup", index, len(cleanup), _path(raw, "source").name)
        source, target, backup = (_path(raw, key) for key in ("source", "target", "backup"))
        if (
            not source.is_absolute()
            or source == source.parent
            or backup != source.with_name(source.name + ".storage-migrated")
            or not target.resolve().is_relative_to(marker.parent.resolve())
            or source.resolve() == marker.parent.resolve()
        ):
            raise ValueError("Invalid migration cleanup paths")
        _link_source(source, target, backup)
        if source.resolve() != target.resolve():
            raise ValueError(f"Migration compatibility link failed: {source}")
        raw["phase"] = "linked"
        atomic_write_text(marker, dumps(state))
        if backup.exists():
            shutil.rmtree(backup)
    atomic_write_text(
        marker.with_name("storage-layout.json"), dumps({**state, "phase": "complete"})
    )
    _remove_temporary(state, marker.parent)
    marker.unlink()
    marker.with_name(".storage-files.json").unlink(missing_ok=True)
    _report("Done")


def _remove_temporary(state: dict[str, object], root: Path) -> None:
    if "copy_temporary" not in state:
        return
    temporary = _path(state, "copy_temporary")
    if temporary.parent.resolve() != (root / "temp").resolve() or not temporary.name.startswith(
        "storage-"
    ):
        raise ValueError("Invalid migration temporary directory")
    if temporary.is_junction() or temporary.is_symlink():
        raise ValueError("Migration temporary directory was replaced with a link")
    if temporary.exists():
        shutil.rmtree(temporary)


def _schedule_finish(
    state: dict[str, object],
    marker: Path,
    lease: BackendInstanceLock,
    wait_parent: int,
    source_locks: Sequence[BackendInstanceLock] = (),
) -> None:
    root = marker.parent
    with ExitStack() as stack:
        locks = list(source_locks)
        if not locks:
            targets = {_path(item, "target").resolve() for item in _records(state, "libraries")}
            for item in _records(state, "libraries"):
                source = _path(item, "source")
                if not source.is_dir() or source.resolve() in targets:
                    continue
                lock = BackendInstanceLock(source / "backend.lock", adopt_marker=True)
                lock.acquire()
                stack.callback(lock.release)
                locks.append(lock)
        _validate_destination(state, marker)
        _verify_sources(state, marker)
        cleanup_marker = marker.with_name(".storage-cleanup")
        if marker != cleanup_marker:
            marker.rename(cleanup_marker)
        _report("Waiting")
        handoff = root / f".storage-worker-{UuidGenerator().new()}.pid"
        worker = _completion_worker(state, root, cleanup_marker, wait_parent, handoff)
        worker_pid = _await_handoff(worker, handoff)
        for lock in locks:
            lock.transfer_to(worker_pid)
        close_progress()
        lease.transfer_to(worker_pid)
        handoff.unlink(missing_ok=True)


def _unlink_compatibility(target: Path) -> None:
    root = target.parent.resolve()
    if any((root / name).exists() for name in (".storage-migration", ".storage-cleanup")):
        raise ValueError("Application data migration must finish before uninstalling")
    layout = root / "storage-layout.json"
    if not layout.is_file():
        return
    state = loads_object(layout.read_text(encoding="utf-8"))
    with ExitStack() as stack:
        for item in _records(state, "libraries"):
            folder = _path(item, "target")
            if not folder.resolve().is_relative_to(root):
                raise ValueError("Invalid installed library location")
            lock = BackendInstanceLock(folder / "backend.lock")
            lock.acquire()
            stack.callback(lock.release)
        aliases = []
        if "logical_profile" in state:
            aliases.append((_path(state, "logical_profile"), target))
        aliases.extend(
            (_path(item, "source"), _path(item, "target")) for item in _records(state, "cleanup")
        )
        for source, destination in aliases:
            if (
                not destination.resolve().is_relative_to(root)
                or source == source.parent
                or not (source.is_symlink() or source.is_junction())
                or source.resolve() != destination.resolve()
            ):
                continue
            if source.is_symlink():
                source.unlink()
            else:
                source.rmdir()


def _verify_source_inventory(
    cleanup: list[dict[str, object]],
    entries: list[dict[str, object]],
    state: dict[str, object],
) -> None:
    for item in cleanup:
        if item.get("phase") == "linked":
            continue
        source, target, backup = (_path(item, key) for key in ("source", "target", "backup"))
        if source.exists() and source.resolve() == target.resolve() and not backup.exists():
            continue
        actual_root = backup if backup.is_dir() else source
        if not actual_root.is_dir():
            raise ValueError(f"The legacy profile is unavailable: {actual_root}")
        expected = {
            _path(entry, "source").relative_to(source)
            for entry in entries
            if _path(entry, "source").is_relative_to(source)
        }
        ignored = {
            actual_root / _path(item, "source").relative_to(source) / name
            for item in _records(state, "libraries")
            if _path(item, "source").is_relative_to(source)
            for name in {*_LOCK_FILES, "app.db-shm"}
        }
        actual = {file.relative_to(actual_root) for file in _files(actual_root, {}, ignored)}
        if expected != actual:
            raise ValueError(f"Legacy file inventory changed; its data was preserved: {source}")


def _verify_destination_libraries(
    state: dict[str, object],
    root: Path,
    identities: dict[object, object],
) -> None:
    for item in _records(state, "libraries"):
        target = _path(item, "target")
        if not target.resolve().is_relative_to(root):
            raise ValueError(f"The verified destination library is unavailable: {target}")
        if not item.get("database"):
            continue
        if not (target / "app.db").is_file():
            raise ValueError(f"The verified destination database is unavailable: {target}")
        database = Database(target / "app.db")
        try:
            database.validate()
        finally:
            database.dispose()
        expected = identities.get(str(target))
        if not isinstance(expected, dict):
            raise ValueError("Invalid migration catalog identities")
        with closing(
            sqlite3.connect((target / "app.db").as_uri() + "?mode=ro", uri=True)
        ) as connection:
            for table, values in expected.items():
                if (
                    not isinstance(table, str)
                    or not isinstance(values, list)
                    or any(type(value) is not int for value in values)
                ):
                    raise ValueError("Invalid migration catalog identity")
                escaped = table.replace('"', '""')
                actual = {row[0] for row in connection.execute(f'SELECT id FROM "{escaped}"')}
                if not set(values).issubset(actual):
                    raise ValueError(
                        f"The destination no longer contains the original catalog: {table}"
                    )


def _link_source(source: Path, target: Path, backup: Path) -> None:
    if source.exists() and source.resolve() == target.resolve():
        pass
    else:
        if source.exists():
            if backup.exists():
                raise ValueError(f"Migration backup already exists: {backup}")
            source.rename(backup)
        if not backup.is_dir():
            raise ValueError(f"Migration source disappeared: {source}")
        if os.name != "nt":
            source.symlink_to(target, target_is_directory=True)
        else:
            import _winapi

            _winapi.CreateJunction(str(target), str(source))


def _completion_worker(
    state: dict[str, object],
    root: Path,
    cleanup_marker: Path,
    wait_parent: int,
    handoff: Path,
) -> ProcessHandle:
    with (root / "storage-migration.log").open("ab") as log:
        worker = start_handoff(
            [
                sys.executable,
                "-B",
                "-u",
                "-m",
                "backend.infrastructure.profile_migration",
                str(_path(state, "source")),
                str(_path(state, "target")),
                "--finish-marker",
                str(cleanup_marker),
                "--wait-parent",
                str(wait_parent),
                "--handoff-file",
                str(handoff),
            ],
            log,
        )
    return worker


def _await_handoff(worker: ProcessHandle, handoff: Path) -> int:
    deadline = time.monotonic() + 30
    while not handoff.is_file():
        if worker.poll() is not None or time.monotonic() >= deadline:
            raise ValueError(
                "The storage completion worker did not start; copied data was preserved"
            )
        time.sleep(0.05)
    worker_pid = int(handoff.read_text(encoding="utf-8"))
    return worker_pid
