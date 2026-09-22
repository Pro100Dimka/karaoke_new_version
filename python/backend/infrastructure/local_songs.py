from __future__ import annotations

import os
import shutil
import time
from pathlib import Path

from backend.domain_errors import DependencyError
from backend.infrastructure.hashing import sha256_file
from backend.storage.domain import StorageRoots


class LocalSongStorage:
    def __init__(self, roots: StorageRoots) -> None:
        self._roots = roots

    def copy_source(self, song_id: str, source: Path, expected_hash: str) -> Path:
        target_dir = self._roots.songs / song_id / "source"
        target_dir.mkdir(parents=True, exist_ok=False)
        target = target_dir / f"original{source.suffix.lower()}"
        temporary = target.with_name(f".{target.name}.tmp")
        try:
            shutil.copyfile(source, temporary)
            _fsync_file(temporary)
            if sha256_file(temporary) != expected_hash:
                raise DependencyError("InvalidMedia", "Copied source checksum does not match")
            os.replace(temporary, target)
            return target
        except OSError as exc:
            temporary.unlink(missing_ok=True)
            raise DependencyError("StorageUnavailable", "Could not copy source media") from exc

    def copy_cover(self, song_id: str, source: Path) -> Path:
        target_dir = self._roots.songs / song_id / "cover"
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / source.name
        try:
            shutil.copyfile(source, target)
        except OSError as exc:
            raise DependencyError("StorageUnavailable", "Could not copy custom cover") from exc
        return target

    def quarantine(self, song_id: str) -> Path | None:
        source = self._roots.songs / song_id
        if not source.exists():
            return None
        target = self.quarantine_path(song_id)
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            _replace_with_retry(source, target)
        except OSError as exc:
            raise DependencyError("StorageUnavailable", "Could not quarantine song") from exc
        return target

    def quarantine_path(self, song_id: str) -> Path:
        return self._roots.quarantine / f"song-{song_id}"

    def restore_quarantine(self, song_id: str, quarantine_path: Path) -> None:
        if not quarantine_path.exists():
            return
        target = self._roots.songs / song_id
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(quarantine_path, target)

    def finalize_quarantine(self, quarantine_path: Path) -> None:
        shutil.rmtree(quarantine_path, ignore_errors=True)

    def exists(self, path: Path) -> bool:
        return path.is_file()

    def size(self, path: Path) -> int:
        try:
            return path.stat().st_size
        except OSError as exc:
            raise DependencyError("StorageUnavailable", "Source media size cannot be read") from exc


def _fsync_file(path: Path) -> None:
    with path.open("r+b") as stream:
        os.fsync(stream.fileno())


def _replace_with_retry(source: Path, target: Path) -> None:
    delays = (0.05, 0.1, 0.15, 0.2, 0.25, 0.25, 0.25)
    for delay in delays:
        try:
            os.replace(source, target)
            return
        except PermissionError:
            time.sleep(delay)
    os.replace(source, target)
