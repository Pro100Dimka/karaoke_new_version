from __future__ import annotations
from collections.abc import Sequence
import shutil
import sqlite3
import tempfile
from contextlib import ExitStack, closing
from pathlib import Path
from backend.infrastructure.atomic_files import atomic_write_text
from backend.infrastructure.clock import UtcClock
from backend.infrastructure.database import Database
from backend.infrastructure.hashing import sha256_file
from backend.infrastructure.ids import UuidGenerator
from backend.infrastructure.instance_lock import BackendInstanceLock
from backend.infrastructure.library_storage import SqlLibraryStorage
from backend.infrastructure.local_storage import LocalStorageSystem
from backend.infrastructure.migrations import DatabaseMigrator
from backend.infrastructure.recovery_journal import FileRecoveryJournal
from backend.projects.fingerprint import manifest_fingerprint
from backend.projects.manifest_codec import decode_manifest
from backend.serialization import dumps
from backend.storage.domain import StorageRoots

from backend.infrastructure.profile_progress import (
    _report as _report,
)
from backend.infrastructure.profile_paths import (
    _FILE_FIELDS as _FILE_FIELDS,
    _copy as _copy,
    _external_sources as _external_sources,
    _path as _path,
    _relocate as _relocate,
    _rewrite_metadata as _rewrite_metadata,
)


def _rewrite_database(
    source: Path, working: Path, mappings: dict[Path, Path], profile_target: Path, stage: Path
) -> dict[str, list[int]]:
    original = source / "app.db"
    if not original.is_file():
        return {}
    target = working / "app.db"
    target.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(original.as_uri() + "?mode=ro", uri=True)) as before:
        counts, identities, available = _snapshot_database(
            before, source, working, target, mappings
        )
    database = Database(target)
    try:
        DatabaseMigrator().migrate(database.engine)
        roots, clock = StorageRoots.under(working), UtcClock()
        library = SqlLibraryStorage(
            database,
            roots,
            LocalStorageSystem(roots, clock),
            0,
            FileRecoveryJournal(roots.recovery, clock, UuidGenerator()),
        )
        changed = library.relocate(lambda value: _relocate(value, mappings))
        database.validate()
        with closing(sqlite3.connect(target)) as connection:
            _verify_counts(connection, counts)
            _verify_file_paths(connection, profile_target, stage, available)
            _verify_revisions(connection, changed, roots, source)
            connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        atomic_write_text(working / ".ad-voice-data", "ADVoice.App.v2")
        return identities
    finally:
        database.dispose()


def _refresh_profile(target: Path, marker: Path, layout: dict[str, object]) -> None:
    _report("Prepare")
    mappings, folders, saved = _refresh_roots(target, layout)
    libraries: list[dict[str, object]] = [
        {"source": str(folder), "target": str(folder)} for folder in sorted(folders)
    ]
    state: dict[str, object] = {
        "phase": "refreshing",
        "source": str(target),
        "target": str(target),
        "libraries": libraries,
        "cleanup": [],
    }
    atomic_write_text(marker, dumps(state))
    with ExitStack() as stack:
        for item in libraries:
            folder = _path(item, "source")
            lock = BackendInstanceLock(folder / "backend.lock")
            lock.acquire()
            stack.callback(lock.release)
            item["database"] = (folder / "app.db").is_file()
        original_roots = set(mappings)
        _external_sources(mappings, target, libraries)
        temporary_root = marker.parent / "temp"
        temporary_root.mkdir(exist_ok=True)
        temporary = Path(
            stack.enter_context(tempfile.TemporaryDirectory(prefix="storage-", dir=temporary_root))
        )
        state["copy_temporary"] = str(temporary)
        atomic_write_text(marker, dumps(state))
        _refresh_external_files(mappings, original_roots, temporary_root, temporary, target)
        identities = _refresh_databases(libraries, mappings, target)
        _complete_refresh(target, marker, saved, folders, layout, libraries, identities)


def _snapshot_database(
    before: sqlite3.Connection,
    source: Path,
    working: Path,
    target: Path,
    mappings: dict[Path, Path],
) -> tuple[dict[str, int], dict[str, list[int]], dict[tuple[str, int, str], bool]]:
    counts = {
        name: before.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0]
        for (name,) in before.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    identities = {
        name: [int(row[0]) for row in before.execute(f'SELECT id FROM "{name}"')]
        for name in counts
        if any(row[1] == "id" for row in before.execute(f'PRAGMA table_info("{name}")'))
    }
    available = {
        (table, row[0], field): (
            Path(row[1]).is_file()
            or (source == working and Path(str(_relocate(row[1], mappings))).is_file())
        )
        for table, fields in _FILE_FIELDS.items()
        if table in counts
        for field in fields
        for row in before.execute(f'SELECT id,"{field}" FROM "{table}"')
        if row[1]
    }
    if source != working:
        with closing(sqlite3.connect(target)) as after:
            before.backup(after)
    return counts, identities, available


def _verify_counts(connection: sqlite3.Connection, counts: dict[str, int]) -> None:
    for name, count in counts.items():
        if connection.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0] != count:
            raise ValueError(f"Migration changed the number of rows in {name}")


def _verify_file_paths(
    connection: sqlite3.Connection,
    profile_target: Path,
    stage: Path,
    available: dict[tuple[str, int, str], bool],
) -> None:
    for table, fields in _FILE_FIELDS.items():
        for field in fields:
            for identity, value in connection.execute(f'SELECT id,"{field}" FROM "{table}"'):
                if not value:
                    continue
                file = Path(value)
                if not file.is_absolute() or not file.is_relative_to(profile_target):
                    raise ValueError(f"Migrated file path is outside the installation: {file}")
                copied = stage / file.relative_to(profile_target)
                if copied.is_file() != available.get((table, identity, field), False):
                    raise ValueError(f"File availability changed during migration: {file}")


def _verify_revisions(
    connection: sqlite3.Connection,
    changed: Sequence[tuple[str, int]],
    roots: StorageRoots,
    source: Path,
) -> None:
    for song_id, revision in changed:
        fingerprint = connection.execute(
            "SELECT fingerprint FROM project_revisions WHERE song_id=? AND revision=?",
            (song_id, revision),
        ).fetchone()[0]
        folder = roots.songs / song_id / "revisions" / str(revision)
        manifest = decode_manifest((folder / "manifest.json").read_text(encoding="utf-8"))
        if manifest_fingerprint(manifest) != fingerprint:
            raise ValueError(f"Migrated revision fingerprint failed: {song_id}/{revision}")
        for artifact in manifest.artifacts:
            file = folder / artifact.relative_path
            if artifact.relative_path.is_absolute() or ".." in artifact.relative_path.parts:
                raise ValueError("Invalid revision artifact path")
            original = (
                source / "songs" / song_id / "revisions" / str(revision) / artifact.relative_path
            )
            if file.is_file() != original.is_file():
                raise ValueError(f"Project artifact availability changed during migration: {file}")
            if (
                artifact.relative_path == Path("source.ref")
                and sha256_file(file) != artifact.checksum
            ):
                raise ValueError(f"Migrated source reference checksum failed: {file}")


def _refresh_roots(
    target: Path, layout: dict[str, object]
) -> tuple[dict[Path, Path], set[Path], Path]:
    old_target = layout.get("target", str(target))
    if not isinstance(old_target, str) or not Path(old_target).is_absolute():
        raise ValueError("Invalid installed profile location")
    mappings = {Path(old_target): target, target: target}
    folders = {target / "backend-data"}
    saved = target / "storage-roots.txt"
    if saved.is_file():
        for line in saved.read_text(encoding="utf-8").splitlines():
            value = _relocate(line, mappings)
            if (
                isinstance(value, str)
                and Path(value).is_absolute()
                and Path(value).resolve().is_relative_to(target.resolve())
            ):
                folders.add(Path(value).resolve())
    return mappings, folders, saved


def _refresh_external_files(
    mappings: dict[Path, Path],
    original_roots: set[Path],
    temporary_root: Path,
    temporary: Path,
    target: Path,
) -> None:
    links: dict[tuple[int, int], Path] = {}
    for source, destination in mappings.items():
        if source in original_roots or not source.is_file():
            continue
        _report("Copy", detail=source.name)
        required = source.stat().st_size
        if shutil.disk_usage(temporary_root).free < required + 2**30:
            raise ValueError("Not enough space to move external application media")
        expected = sha256_file(destination) if destination.is_file() else None
        _copy(source, destination, links, temporary, expected, owned=source.is_relative_to(target))


def _refresh_databases(
    libraries: list[dict[str, object]],
    mappings: dict[Path, Path],
    target: Path,
) -> dict[str, dict[str, list[int]]]:
    identities = {}
    for index, item in enumerate(libraries):
        _report("Catalog", index, len(libraries))
        folder = _path(item, "source")
        if item["database"]:
            identities[str(folder)] = _rewrite_database(folder, folder, mappings, target, target)
        _rewrite_metadata(folder, mappings)
    return identities


def _complete_refresh(
    target: Path,
    marker: Path,
    saved: Path,
    folders: set[Path],
    layout: dict[str, object],
    libraries: list[dict[str, object]],
    identities: dict[str, dict[str, list[int]]],
) -> None:
    atomic_write_text(target / "storage-root.txt", str(target / "backend-data"))
    atomic_write_text(saved, "\n".join(str(folder) for folder in sorted(folders)))
    atomic_write_text(
        marker.with_name("storage-layout.json"),
        dumps(
            {
                **layout,
                "phase": "complete",
                "version": 1,
                "target": str(target),
                "libraries": libraries,
                "identities": identities,
            }
        ),
    )
    marker.unlink()
    _report("Done")
