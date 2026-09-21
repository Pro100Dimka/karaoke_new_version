from __future__ import annotations

from dataclasses import dataclass

from backend.storage.ports import StorageSystem

_TEMP_MAX_AGE_SECONDS = 3600


@dataclass(frozen=True, slots=True)
class CleanupResult:
    removed: int


class ClearProcessingCache:
    """Cache is regenerable storage; canonical projects, recordings and models are never touched."""

    def __init__(self, storage: StorageSystem) -> None:
        self._storage = storage

    def execute(self) -> CleanupResult:
        return CleanupResult(self._storage.clear_cache())


class RemoveTemporaryFiles:
    def __init__(self, storage: StorageSystem) -> None:
        self._storage = storage

    def execute(self) -> CleanupResult:
        return CleanupResult(self._storage.cleanup_temp(_TEMP_MAX_AGE_SECONDS))
