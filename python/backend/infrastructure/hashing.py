from __future__ import annotations

import hashlib
from collections.abc import Callable
from pathlib import Path

_CHUNK_SIZE = 1024 * 1024


def sha256_file(path: Path, ensure_not_cancelled: Callable[[], None] | None = None) -> str:
    if ensure_not_cancelled is not None:
        ensure_not_cancelled()
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while True:
            if ensure_not_cancelled is not None:
                ensure_not_cancelled()
            chunk = stream.read(_CHUNK_SIZE)
            if not chunk:
                break
            digest.update(chunk)
    if ensure_not_cancelled is not None:
        ensure_not_cancelled()
    return digest.hexdigest()
