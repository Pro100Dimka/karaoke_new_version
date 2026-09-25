from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path
from typing import Mapping

from backend.domain_errors import DependencyError
from backend.infrastructure.paths import ensure_within, safe_path_component
from backend.runtime import Clock
from backend.storage.domain import StorageRoots


class LocalStorageSystem:
    def __init__(self, roots: StorageRoots, clock: Clock) -> None:
        self._roots = roots
        self._clock = clock

    def initialize(self) -> None:
        for path in self._roots.directories():
            try:
                path.mkdir(parents=True, exist_ok=True)
                probe = path / ".write-probe"
                probe.write_bytes(b"")
                probe.unlink()
            except OSError as exc:
                raise DependencyError(
                    "StorageUnavailable", "Storage root is not writable", path=str(path)
                ) from exc

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

    def cleanup_temp(self, max_age_seconds: int) -> int:
        threshold = self._clock.now().timestamp() - max_age_seconds
        removed = 0
        for path in self._roots.temp.iterdir():
            if path.stat().st_mtime >= threshold:
                continue
            if path.is_dir():
                shutil.rmtree(path, ignore_errors=True)
            else:
                path.unlink(missing_ok=True)
            removed += 1
        return removed

    def clear_cache(self) -> int:
        removed = 0
        for path in self._roots.cache.iterdir():
            if path.is_dir():
                shutil.rmtree(path, ignore_errors=True)
            else:
                path.unlink(missing_ok=True)
            removed += 1
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
    return sum(path.stat().st_size for path in root.rglob("*") if path.is_file())


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
