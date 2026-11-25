from __future__ import annotations

import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass


@dataclass
class _LockEntry:
    lock: threading.RLock
    users: int = 0


class KeyedLockManager:
    def __init__(self) -> None:
        self._guard = threading.Lock()
        self._locks: dict[str, _LockEntry] = {}

    @contextmanager
    def acquire(
        self, key: str, *, ensure_not_cancelled: Callable[[], None] | None = None
    ) -> Iterator[None]:
        with self._guard:
            entry = self._locks.get(key)
            if entry is None:
                entry = _LockEntry(threading.RLock())
                self._locks[key] = entry
            # Count waiters as well as owners, including reentrant ownership.
            entry.users += 1
        acquired = False
        try:
            if ensure_not_cancelled is None:
                entry.lock.acquire()
                acquired = True
            else:
                ensure_not_cancelled()
                while not entry.lock.acquire(timeout=0.05):
                    ensure_not_cancelled()
                acquired = True
                ensure_not_cancelled()
            yield
        finally:
            if acquired:
                entry.lock.release()
            with self._guard:
                entry.users -= 1
                if entry.users == 0:
                    del self._locks[key]
