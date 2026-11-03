from __future__ import annotations
import os
import sys
import threading
import time
from pathlib import Path
from backend.infrastructure.job_executor import run_in_background
from backend.infrastructure.atomic_files import atomic_write_text
from backend.domain_errors import DependencyError
from backend.serialization import dumps


class _Progress:
    def __init__(self, root: Path) -> None:
        self._file = root / "storage-progress.json"
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._state: dict[str, object] = {}
        self._started = time.monotonic()
        self._sent = 0.0
        self._thread = run_in_background("storage-progress", self._heartbeat)

    def update(self, phase: str, done: int = 0, total: int = 0, detail: str = "") -> None:
        with self._lock:
            changed = self._state.get("phase") != phase
            if changed:
                self._started = time.monotonic()
            self._state = {
                "phase": phase,
                "done": done,
                "total": total,
                "detail": detail,
                "pid": os.getpid(),
            }
            if changed or time.monotonic() - self._sent >= 0.25 or (total > 0 and done == total):
                self._emit()

    def _emit(self) -> None:
        if not self._state:
            return
        self._sent = time.monotonic()
        state = {
            **self._state,
            "elapsed": int(self._sent - self._started),
            "updatedAt": int(time.time() * 1000),
        }
        try:
            atomic_write_text(self._file, dumps(state))
        except DependencyError as exc:
            print(f"STORAGE_STATUS_WARNING|{exc.__cause__}", file=sys.stderr, flush=True)
        detail = str(state["detail"]).replace("|", "/").replace("\n", " ").replace("\r", " ")
        print(
            f"STORAGE|{state['phase']}|{state['done']}|{state['total']}|{state['elapsed']}|{detail}",
            flush=True,
        )

    def _heartbeat(self) -> None:
        while not self._stop.wait(1):
            with self._lock:
                self._emit()

    def close(self) -> None:
        self._stop.set()
        self._thread.join()


_progress: _Progress | None = None


def _report(phase: str, done: int = 0, total: int = 0, detail: str = "") -> None:
    if _progress is not None:
        _progress.update(phase, done, total, detail)


def start_progress(root: Path) -> None:
    global _progress
    _progress = _Progress(root)


def close_progress() -> None:
    if _progress is not None:
        _progress.close()
