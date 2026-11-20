from __future__ import annotations

from collections.abc import Callable, Mapping
from pathlib import Path, PurePosixPath

from backend.domain_errors import DependencyError


def copy_snapshot_files(
    files: Mapping[PurePosixPath, Path],
    destination: Path,
    require_free: Callable[[int], None],
    progress: Callable[[float], None],
) -> dict[PurePosixPath, Path]:
    """Copy once so hashing and archive streaming read the same bytes after media edits."""
    snapshots: dict[PurePosixPath, Path] = {}
    progress(0.0)
    try:
        total = sum(source.stat().st_size for source in files.values())
        require_free(total * 2)  # The snapshot and output archive coexist on the source drive.
        copied = 0
        for relative, source in files.items():
            progress(min(1.0, copied / max(1, total)))
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.open("rb") as original, target.open("wb") as snapshot:
                while chunk := original.read(1024 * 1024):
                    snapshot.write(chunk)
                    copied += len(chunk)
                    progress(min(1.0, copied / max(1, total)))
            snapshots[relative] = target
    except OSError as exc:
        raise DependencyError("StorageUnavailable", "Library snapshot could not be copied") from exc
    progress(1.0)
    return snapshots
