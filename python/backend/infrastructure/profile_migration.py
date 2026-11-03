"""Move the installed profile before activation after an update."""

from __future__ import annotations
from backend.infrastructure.profile_cli import run_profile_command
import shutil
import tempfile
from contextlib import ExitStack
from pathlib import Path
from backend.infrastructure.atomic_files import atomic_write_text
from backend.infrastructure.instance_lock import BackendInstanceLock
from backend.serialization import dumps, loads_object

from backend.infrastructure.profile_progress import (
    _Progress as _Progress,
    _report as _report,
    close_progress as close_progress,
    start_progress as start_progress,
)
from backend.infrastructure.profile_paths import (
    _DATA_NAMES as _DATA_NAMES,
    _FILE_FIELDS as _FILE_FIELDS,
    _IMMUTABLE_MEDIA as _IMMUTABLE_MEDIA,
    _LOCK_FILES as _LOCK_FILES,
    _copy as _copy,
    _external_sources as _external_sources,
    _files as _files,
    _path as _path,
    _plans as _plans,
    _records as _records,
    _relocate as _relocate,
    _rewrite_metadata as _rewrite_metadata,
)
from backend.infrastructure.profile_database import (
    _refresh_profile as _refresh_profile,
    _rewrite_database as _rewrite_database,
)
from backend.infrastructure.profile_cleanup import (
    _finish as _finish,
    _remove_sources as _remove_sources,
    _remove_temporary as _remove_temporary,
    _schedule_finish as _schedule_finish,
    _unlink_compatibility as _unlink_compatibility,
    _validate_destination as _validate_destination,
    _verify_sources as _verify_sources,
)


def migrate(profile: Path, target: Path, *, wait_parent: int = 0) -> None:
    target = target.absolute()
    installation = target.parents[1].resolve()
    root = target.parent.resolve()
    if not root.is_relative_to(installation):
        raise ValueError("Installed data directory must stay inside its installation")
    target = root / target.name
    root.mkdir(parents=True, exist_ok=True)
    if not target.resolve().is_relative_to(installation):
        raise ValueError("Installed data directory must not point outside its installation")
    lease = BackendInstanceLock(root / ".storage-worker.lock")
    lease.acquire()
    try:
        _migrate_locked(profile, target, root, lease, wait_parent)
    finally:
        close_progress()
        lease.release()


def _resume_profile(
    profile: Path,
    target: Path,
    root: Path,
    stage: Path,
    marker: Path,
    state: dict[str, object],
    lease: BackendInstanceLock,
    wait_parent: int,
) -> bool:
    if state.get("phase") == "publishing" and target.is_dir() and not stage.exists():
        state["phase"] = "published"
        atomic_write_text(marker, dumps(state))
    if state.get("phase") == "published":
        if wait_parent > 0:
            _schedule_finish(state, marker, lease, wait_parent)
        else:
            _finish(state, marker)
        return True
    layout_file = root / "storage-layout.json"
    if _refresh_existing_profile(state, profile, target, root, marker, layout_file):
        return True
    return _initialize_empty_profile(profile, target, marker, layout_file)


def _validated_mappings(
    profile: Path,
    target: Path,
    state: dict[str, object],
    stage: Path,
    root: Path,
) -> dict[Path, Path]:
    if state and (state.get("source") != str(profile) or state.get("target") != str(target)):
        raise ValueError("Migration source changed; the previous staged data was preserved")
    if stage.exists() and not state:
        raise ValueError("An unrecognized migration staging directory was preserved")
    _remove_temporary(state, root)
    if target.is_relative_to(profile) or profile.is_relative_to(target):
        raise ValueError("Migration source and destination overlap")
    if target.exists() and any(target.iterdir()):
        raise ValueError(f"Both profiles already contain data; no files were overwritten: {target}")
    mappings = _plans(profile, target)
    _validate_library_ownership(mappings, profile, target)
    return mappings


def _copy_plan(
    profile: Path, logical_profile: Path, target: Path, mappings: dict[Path, Path]
) -> dict[str, object]:
    cleanup = [
        source
        for source in mappings
        if not any(source != other and source.is_relative_to(other) for other in mappings)
    ]
    cleanup_state = [
        {
            "source": str(source),
            "target": str(mappings[source]),
            "backup": str(source.with_name(source.name + ".storage-migrated")),
        }
        for source in cleanup
    ]
    libraries: list[dict[str, object]] = [
        {"source": str(source), "target": str(destination)}
        for source, destination in mappings.items()
        if destination == target / "backend-data"
        or destination.relative_to(target).parts[:1] == ("legacy-data",)
    ]
    state = {
        "phase": "copying",
        "version": 1,
        "source": str(profile),
        "logical_profile": str(logical_profile),
        "target": str(target),
        "cleanup": cleanup_state,
        "libraries": libraries,
    }
    return state


def _lock_sources(
    libraries: list[dict[str, object]], stack: ExitStack
) -> list[BackendInstanceLock]:
    source_locks = []
    for item in libraries:
        source = _path(item, "source")
        lock = BackendInstanceLock(source / "backend.lock")
        lock.acquire()
        source_locks.append(lock)
        stack.callback(lock.release)
        item["database"] = (source / "app.db").is_file()
    return source_locks


def _copy_entries(
    mappings: dict[Path, Path],
    libraries: list[dict[str, object]],
    target: Path,
    stage: Path,
    root: Path,
) -> list[tuple[Path, Path]]:
    ignored = {
        _path(item, "source") / name for item in libraries for name in {*_LOCK_FILES, "app.db-shm"}
    }
    entries = [
        (file, stage / destination.relative_to(target) / file.relative_to(source))
        for source, destination in mappings.items()
        for file in _files(source, mappings, ignored)
    ]
    unique = {(file.stat().st_dev, file.stat().st_ino): file.stat().st_size for file, _ in entries}
    allocated = {
        (file.stat().st_dev, file.stat().st_ino): file.stat().st_size
        for file in stage.rglob("*")
        if file.is_file()
    }
    if (
        shutil.disk_usage(root).free
        < max(0, sum(unique.values()) - sum(allocated.values())) + 2**30
    ):
        raise ValueError("Not enough free space to migrate the application data safely")
    return entries


def _copy_inventory(
    entries: list[tuple[Path, Path]],
    links: dict[tuple[int, int], Path],
    temporary_dir: Path,
    cleanup_state: list[dict[str, object]],
    target: Path,
    stage: Path,
    root: Path,
) -> None:
    destination_hashes: dict[Path, str] = {}
    inventory = []
    for index, (file, destination) in enumerate(entries, 1):
        _report("Copy", index - 1, len(entries), file.name)
        owned = any(file.is_relative_to(_path(item, "source")) for item in cleanup_state)
        digest = _copy(
            file,
            destination,
            links,
            temporary_dir,
            destination_hashes.get(destination),
            owned=owned,
        )
        destination_hashes[destination] = digest
        info = destination.stat()
        inventory.append(
            {
                "source": str(file),
                "target": str(target / destination.relative_to(stage)),
                "sha256": digest,
                "size": info.st_size,
                "mtime": info.st_mtime_ns,
            }
        )
    _report("Copy", len(entries), len(entries))
    atomic_write_text(root / ".storage-files.json", dumps({"files": inventory}))


def _rewrite_stage(
    mappings: dict[Path, Path],
    logical_profile: Path,
    target: Path,
    stage: Path,
    libraries: list[dict[str, object]],
    state: dict[str, object],
) -> None:
    replacements = {**mappings, logical_profile: target}
    identities = {}
    for index, item in enumerate(libraries):
        _report("Catalog", index, len(libraries))
        source, destination = _path(item, "source"), _path(item, "target")
        working = stage / destination.relative_to(target)
        if item["database"]:
            identities[str(destination)] = _rewrite_database(
                source, working, replacements, target, stage
            )
        _rewrite_metadata(working, replacements)
    if {str(_path(item, "target")) for item in libraries if item["database"]} != set(identities):
        raise ValueError(
            "A legacy database disappeared during migration; staged data was preserved"
        )
    state["identities"] = identities
    atomic_write_text(stage / "backend-data" / ".ad-voice-data", "ADVoice.App.v2")
    atomic_write_text(stage / "storage-root.txt", str(target / "backend-data"))
    atomic_write_text(
        stage / "storage-roots.txt",
        "\n".join(
            sorted(
                {
                    str(target / "backend-data"),
                    *(str(_path(item, "target")) for item in libraries),
                }
            )
        ),
    )


def _migrate_locked(
    profile: Path, target: Path, root: Path, lease: BackendInstanceLock, wait_parent: int
) -> None:
    start_progress(root)
    _report("Prepare")
    marker = (
        root / ".storage-cleanup"
        if (root / ".storage-cleanup").is_file()
        else root / ".storage-migration"
    )
    state = loads_object(marker.read_text(encoding="utf-8")) if marker.is_file() else {}
    stage = root / ".storage-stage"
    if _resume_profile(profile, target, root, stage, marker, state, lease, wait_parent):
        return
    logical_profile, profile = profile.absolute(), profile.resolve()
    mappings = _validated_mappings(profile, target, state, stage, root)
    state = _copy_plan(profile, logical_profile, target, mappings)
    libraries = _records(state, "libraries")
    cleanup_state = _records(state, "cleanup")
    atomic_write_text(marker, dumps(state))
    stage.mkdir(exist_ok=True)
    with ExitStack() as stack:
        source_locks = _lock_sources(libraries, stack)
        _external_sources(mappings, target, libraries)
        entries = _copy_entries(mappings, libraries, target, stage, root)
        links: dict[tuple[int, int], Path] = {}
        temporary_root = root / "temp"
        temporary_root.mkdir(exist_ok=True)
        temporary_dir = Path(
            stack.enter_context(tempfile.TemporaryDirectory(prefix="storage-", dir=temporary_root))
        )
        state["copy_temporary"] = str(temporary_dir)
        atomic_write_text(marker, dumps(state))
        _copy_inventory(entries, links, temporary_dir, cleanup_state, target, stage, root)
        _rewrite_stage(mappings, logical_profile, target, stage, libraries, state)
        _publish_stage(state, marker, target, stage, lease, wait_parent, source_locks)


def _initialize_empty_profile(profile: Path, target: Path, marker: Path, layout_file: Path) -> bool:
    if not profile.exists() and (profile.is_symlink() or profile.is_junction()):
        raise ValueError(f"The legacy profile is unavailable: {profile}")
    if not profile.exists() or profile.resolve() == target.resolve():
        if marker.exists():
            raise ValueError("The legacy migration source is unavailable; no data was discarded")
        target.mkdir(parents=True, exist_ok=True)
        atomic_write_text(
            layout_file,
            dumps(
                {
                    "phase": "complete",
                    "version": 1,
                    "target": str(target),
                    "cleanup": [],
                    "libraries": [],
                    "identities": {},
                }
            ),
        )
        _report("Done")
        return True
    return False


def _refresh_existing_profile(
    state: dict[str, object],
    profile: Path,
    target: Path,
    root: Path,
    marker: Path,
    layout_file: Path,
) -> bool:
    if state.get("phase") == "refreshing" or (
        not state
        and target.is_dir()
        and (layout_file.is_file() or (profile.exists() and profile.resolve() == target.resolve()))
    ):
        _remove_temporary(state, root)
        layout = (
            loads_object(layout_file.read_text(encoding="utf-8")) if layout_file.is_file() else {}
        )
        _refresh_profile(target, marker, layout)
        return True
    return False


def _validate_library_ownership(mappings: dict[Path, Path], profile: Path, target: Path) -> None:
    for source in mappings:
        if source.is_dir() and (target.is_relative_to(source) or source.is_relative_to(target)):
            raise ValueError("A legacy library overlaps the installed data directory")
        if source == profile or source.is_relative_to(profile):
            continue
        if not (source / ".ad-voice-data").is_file() or any(
            item.name not in _DATA_NAMES for item in source.iterdir()
        ):
            raise ValueError(f"Exclusive library ownership could not be verified: {source}")


def _publish_stage(
    state: dict[str, object],
    marker: Path,
    target: Path,
    stage: Path,
    lease: BackendInstanceLock,
    wait_parent: int,
    source_locks: list[BackendInstanceLock],
) -> None:
    _verify_sources(state, marker)
    _report("Publish")
    state["phase"] = "publishing"
    atomic_write_text(marker, dumps(state))
    if target.exists():
        target.rmdir()
    stage.rename(target)
    state["phase"] = "published"
    atomic_write_text(marker, dumps(state))
    if wait_parent > 0:
        _schedule_finish(state, marker, lease, wait_parent, source_locks)
    else:
        _finish(state, marker, source_locks)


def main() -> int:
    return run_profile_command(migrate)


if __name__ == "__main__":
    raise SystemExit(main())
