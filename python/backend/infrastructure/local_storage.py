from __future__ import annotations

import os
import logging
import shutil
import tempfile
from pathlib import Path
from typing import Mapping

from backend.domain_errors import DependencyError
from backend.infrastructure.paths import ensure_within, safe_path_component
from backend.runtime import Clock
from backend.storage.domain import StorageRoots

logger = logging.getLogger(__name__)


class LocalStorageSystem:
    def __init__(self, roots: StorageRoots, clock: Clock) -> None:
        self._roots = roots
        self._clock = clock

    def initialize(self) -> None:
        # The instance lock is acquired before storage initialization. Only an otherwise
        # empty root proves that these directories were created for this application.
        fresh = not self._roots.app.exists() or all(
            child.name in {"backend.lock", "backend.lock.guard"}
            for child in self._roots.app.iterdir()
        )
        for path in self._roots.directories():
            try:
                path.mkdir(parents=True, exist_ok=True)
                with tempfile.TemporaryFile(dir=path):
                    pass
            except OSError as exc:
                raise DependencyError(
                    "StorageUnavailable", "Storage root is not writable", path=str(path)
                ) from exc
        if fresh:
            (self._roots.app / ".ad-voice-data").write_text("ADVoice.App.v2", encoding="utf-8")

    def free_bytes(self, path: Path) -> int:
        existing = path
        while not existing.exists() and existing.parent != existing:
            existing = existing.parent
        return int(shutil.disk_usage(existing).free)

    def usage(self) -> Mapping[str, int]:
        return {
            "songs": _tree_size(self._roots.songs),
            "models": _tree_size(self._roots.models),
            "cache": _tree_size(self._roots.cache),
            "recordings": _tree_size(self._roots.recordings),
            "temp": _tree_size(self._roots.temp),
            "free": self.free_bytes(self._roots.app),
        }

    def require_free(self, path: Path, required_bytes: int) -> None:
        if required_bytes < 0:
            raise ValueError("required_bytes cannot be negative")
        if self.free_bytes(path) < required_bytes:
            raise DependencyError(
                "InsufficientDiskSpace",
                "Operation requires more free disk space",
                requiredBytes=required_bytes,
            )

    def cleanup_temp(self, max_age_seconds: int, *, strict: bool = False) -> int:
        threshold = self._clock.now().timestamp() - max_age_seconds
        return self._cleanup(self._roots.temp, threshold, strict=strict)

    def clear_cache(self) -> int:
        return self._cleanup(self._roots.cache, None, strict=True)

    def _cleanup(self, root: Path, threshold: float | None, *, strict: bool) -> int:
        removed = 0
        path = root
        try:
            for path in root.iterdir():
                try:
                    if threshold is not None and path.stat().st_mtime >= threshold:
                        continue
                    if path.is_dir():
                        shutil.rmtree(path)
                    else:
                        path.unlink()
                except FileNotFoundError:
                    if path.exists():
                        raise
                    continue
                except OSError:
                    if strict:
                        raise
                    logger.warning("Temporary file cleanup deferred: %s", path, exc_info=True)
                    continue
                removed += 1
        except OSError as exc:
            if strict:
                raise DependencyError(
                    "StorageUnavailable",
                    "Some files could not be removed; close applications using them and retry",
                    path=str(path),
                    removed=removed,
                ) from exc
            logger.warning("Temporary file cleanup deferred: %s", path, exc_info=True)
        return removed


class LocalModelStorage:
    def __init__(self, roots: StorageRoots) -> None:
        self._roots = roots

    def temporary_path(self, model_id: str, version: str) -> Path:
        directory = self.final_path(model_id, version).parent
        directory.mkdir(parents=True, exist_ok=True)
        descriptor, name = tempfile.mkstemp(prefix=".model-", suffix=".download", dir=directory)
        os.close(descriptor)
        return Path(name)

    def final_path(self, model_id: str, version: str) -> Path:
        path = self._roots.models / safe_path_component(model_id) / safe_path_component(version)
        return ensure_within(path / "model.bin", self._roots.models)

    def publish(self, temporary: Path, final: Path) -> None:
        temporary = ensure_within(temporary, self._roots.models)
        final = ensure_within(final, self._roots.models)
        final.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.replace(temporary, final)
        except OSError as exc:
            raise DependencyError("StorageUnavailable", "Model publication failed") from exc

    def delete(self, path: Path) -> None:
        ensure_within(path, self._roots.models).unlink(missing_ok=True)


def _tree_size(root: Path) -> int:
    if not root.exists():
        return 0
    pending = [str(root)]
    total = 0
    while pending:
        try:
            entries = os.scandir(pending.pop())
        except OSError:
            # Match rglob: inaccessible or removed directories are not traversed.
            continue
        with entries:
            for entry in entries:
                try:
                    if entry.is_dir(follow_symlinks=False):
                        pending.append(entry.path)
                    elif entry.is_file():
                        total += entry.stat().st_size
                except OSError:
                    # Background work may remove an entry after it was listed.
                    continue
    return total


class LocalWorkStorage:
    def __init__(self, root: Path) -> None:
        self._root = root

    def allocate(self, prefix: str) -> Path:
        self._root.mkdir(parents=True, exist_ok=True)
        return Path(tempfile.mkdtemp(prefix=f"{prefix}-", dir=self._root))

    def cleanup(self, path: Path) -> None:
        shutil.rmtree(path, ignore_errors=True)


class LocalPackageOutputStorage:
    def __init__(self, root: Path) -> None:
        self._root = root

    def path_for_export(self, song_id: str, revision: int) -> Path:
        self._root.mkdir(parents=True, exist_ok=True)
        return self._root / f"{song_id}-r{revision}.advoice.zip"
