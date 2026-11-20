from __future__ import annotations

from collections.abc import Callable

from backend.domain_errors import ConflictError
from backend.processing.job_manager import ProcessingJobManager
from backend.storage.ports import StorageSystem


class ClearStorage:
    """Manual cleanup must not invalidate inputs still owned by background work."""

    def __init__(self, storage: StorageSystem, jobs: ProcessingJobManager) -> None:
        self._storage, self._jobs = storage, jobs

    def clear_cache(self) -> int:
        return self._when_idle(self._storage.clear_cache)

    def clear_temp(self) -> int:
        return self._when_idle(lambda: self._storage.cleanup_temp(3600, strict=True))

    def _when_idle(self, action: Callable[[], int]) -> int:
        removed = 0

        def clear() -> None:
            nonlocal removed
            removed = action()

        self._jobs.run_when_idle(
            clear,
            busy_error=ConflictError(
                "StorageInUse",
                "Wait for background jobs to finish before clearing cached or temporary files",
            ),
        )
        return removed
