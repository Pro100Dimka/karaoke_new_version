from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from threading import Condition


class RecordingLifecycle:
    """Keep concurrent registrations atomic with the library-wide deletion snapshot."""

    def __init__(self) -> None:
        self._condition = Condition()
        self._registrations = 0
        self._deleting = False
        self._waiting_deletions = 0

    @contextmanager
    def registration(self) -> Iterator[None]:
        with self._condition:
            self._condition.wait_for(lambda: not self._deleting and self._waiting_deletions == 0)
            self._registrations += 1
        try:
            yield
        finally:
            with self._condition:
                self._registrations -= 1
                self._condition.notify_all()

    @contextmanager
    def deletion(self) -> Iterator[None]:
        with self._condition:
            self._waiting_deletions += 1
            try:
                self._condition.wait_for(lambda: not self._deleting and self._registrations == 0)
                self._deleting = True
            finally:
                self._waiting_deletions -= 1
                self._condition.notify_all()
        try:
            yield
        finally:
            with self._condition:
                self._deleting = False
                self._condition.notify_all()
