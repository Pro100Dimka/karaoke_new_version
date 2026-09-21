from __future__ import annotations

import threading
from collections.abc import Iterator
from contextlib import contextmanager
from enum import StrEnum

from backend.domain_errors import ConflictError


class SongOperation(StrEnum):
    PROCESSING = "Processing"
    EDITOR_SAVE = "EditorSave"
    PROJECT_PUBLISH = "ProjectPublish"
    PACKAGE_EXPORT = "PackageExport"
    PACKAGE_IMPORT = "PackageImport"
    REPAIR = "Repair"
    DELETE = "Delete"
    MIGRATION = "Migration"


class SongOperationRegistry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._active: dict[str, SongOperation] = {}

    def claim(self, song_id: str, operation: SongOperation) -> None:
        self._claim(song_id, operation)

    def release(self, song_id: str, operation: SongOperation) -> None:
        self._release(song_id, operation)

    @contextmanager
    def acquire(self, song_id: str, operation: SongOperation) -> Iterator[None]:
        self._claim(song_id, operation)
        try:
            yield
        finally:
            self._release(song_id, operation)

    def active(self, song_id: str) -> SongOperation | None:
        with self._lock:
            return self._active.get(song_id)

    def any_active(self) -> bool:
        with self._lock:
            return bool(self._active)

    def _claim(self, song_id: str, operation: SongOperation) -> None:
        with self._lock:
            existing = self._active.get(song_id)
            if existing:
                raise ConflictError(
                    "SongOperationConflict",
                    "Another project-mutating operation is active",
                    activeOperation=existing.value,
                )
            self._active[song_id] = operation

    def _release(self, song_id: str, operation: SongOperation) -> None:
        with self._lock:
            if self._active.get(song_id) is operation:
                self._active.pop(song_id, None)
