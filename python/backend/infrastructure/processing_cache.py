from __future__ import annotations

import shutil
from pathlib import Path

from backend.infrastructure.atomic_files import atomic_write_text
from backend.infrastructure.hashing import sha256_file


class LocalProcessingCache:
    def __init__(self, root: Path) -> None:
        self._root = root

    def get(self, key: str) -> Path | None:
        data = self._root / key / "artifact.wav"
        checksum = self._root / key / "checksum.txt"
        if not data.is_file() or not checksum.is_file():
            return None
        expected = checksum.read_text(encoding="utf-8").strip()
        if sha256_file(data) == expected:
            return data
        shutil.rmtree(data.parent, ignore_errors=True)
        return None

    def put(self, key: str, source: Path) -> Path:
        root = self._root / key
        root.mkdir(parents=True, exist_ok=True)
        target = root / "artifact.wav"
        shutil.copyfile(source, target)
        atomic_write_text(root / "checksum.txt", sha256_file(target))
        return target

    def delete(self, key: str) -> None:
        shutil.rmtree(self._root / key, ignore_errors=True)
