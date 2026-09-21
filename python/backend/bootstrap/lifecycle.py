from __future__ import annotations

import threading
from dataclasses import dataclass
from enum import StrEnum


class BackendState(StrEnum):
    STARTING = "Starting"
    READY = "Ready"
    DEGRADED = "Degraded"
    STOPPING = "Stopping"
    FAILED = "Failed"


@dataclass(frozen=True, slots=True)
class LifecycleSnapshot:
    state: BackendState
    reasons: tuple[str, ...]


class BackendLifecycle:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state = BackendState.STARTING
        self._reasons: tuple[str, ...] = ()

    def snapshot(self) -> LifecycleSnapshot:
        with self._lock:
            return LifecycleSnapshot(self._state, self._reasons)

    def ready(self) -> None:
        self._set(BackendState.READY, ())

    def degraded(self, *reasons: str) -> None:
        self._set(BackendState.DEGRADED, tuple(reasons))

    def stopping(self) -> None:
        self._set(BackendState.STOPPING, self._reasons)

    def failed(self, reason: str) -> None:
        self._set(BackendState.FAILED, (reason,))

    def accepts_heavy_work(self) -> bool:
        return self.snapshot().state in {BackendState.READY, BackendState.DEGRADED}

    def _set(self, state: BackendState, reasons: tuple[str, ...]) -> None:
        with self._lock:
            self._state = state
            self._reasons = reasons
