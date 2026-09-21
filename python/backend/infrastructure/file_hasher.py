from __future__ import annotations

from pathlib import Path

from backend.infrastructure.hashing import sha256_file


class Sha256FileHasher:
    def hash_file(self, path: Path) -> str:
        return sha256_file(path)
