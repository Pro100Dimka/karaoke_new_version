"""Keep native BLAS calls inside the render's worker budget, including overlapping jobs."""

from collections.abc import Iterator
from contextlib import contextmanager
import threading
from typing import Protocol, cast

from threadpoolctl import threadpool_limits


class _Restorable(Protocol):
    def restore_original_limits(self) -> None: ...


class _BlasBudget:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._users = 0
        self._limits: _Restorable | None = None

    @contextmanager
    def limit(self) -> Iterator[None]:
        # threadpoolctl changes process-wide settings. Independent job contexts
        # must share one lifetime, otherwise one job restores another's limit.
        with self._lock:
            if self._users == 0:
                self._limits = cast(_Restorable, threadpool_limits(limits=1, user_api="blas"))
            self._users += 1
        try:
            yield
        finally:
            with self._lock:
                self._users -= 1
                if self._users == 0 and self._limits is not None:
                    self._limits.restore_original_limits()
                    self._limits = None


_budget = _BlasBudget()
native_threads = _budget.limit
