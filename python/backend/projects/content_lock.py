from __future__ import annotations

import threading
from collections.abc import Iterator
from contextlib import contextmanager


class KeyedLockManager:
    def __init__(self) -> None:
        self._guard = threading.Lock()
        self._locks: dict[str, threading.RLock] = {}

    @contextmanager
    def acquire(self, key: str) -> Iterator[None]:
        lock = self._get(key)
        with lock:
            yield

    def _get(self, key: str) -> threading.RLock:
        with self._guard:
            return self._locks.setdefault(key, threading.RLock())
