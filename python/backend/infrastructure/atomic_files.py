from __future__ import annotations

import os
import time
from pathlib import Path

from backend.domain_errors import DependencyError


def atomic_write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    try:
        with temporary.open("wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except OSError as exc:
        temporary.unlink(missing_ok=True)
        raise DependencyError(
            "StorageUnavailable", "Atomic file write failed", path=str(path)
        ) from exc


def atomic_write_text(path: Path, text: str) -> None:
    atomic_write_bytes(path, text.encode("utf-8"))


def replace_with_retry(source: Path, target: Path) -> None:
    delays = (0.05, 0.1, 0.15, 0.2, 0.25, 0.25, 0.25)
    for delay in delays:
        try:
            os.replace(source, target)
            return
        except PermissionError:
            time.sleep(delay)
    os.replace(source, target)
