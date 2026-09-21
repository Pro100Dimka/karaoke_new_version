from __future__ import annotations

import threading

from backend.diagnostics.ports import RuntimeDiagnostics, RuntimeProbe


class CachedRuntimeProbe:
    def __init__(self, source: RuntimeProbe) -> None:
        self._source = source
        self._lock = threading.Lock()
        self._value: RuntimeDiagnostics | None = None

    def inspect(self) -> RuntimeDiagnostics:
        with self._lock:
            if self._value is None:
                self._value = self._source.inspect()
            return self._value
