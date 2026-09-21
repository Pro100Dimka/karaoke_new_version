from __future__ import annotations

import sys
import threading
from pathlib import Path

import pytest

from backend.domain_errors import ConflictError, DependencyError, DomainError
from backend.infrastructure.job_executor import BoundedJobExecutor
from backend.infrastructure.paths import ensure_within, safe_relative_path
from backend.infrastructure.process_runner import ProcessRunner


def test_bounded_executor_rejects_work_when_queue_is_full() -> None:
    executor = BoundedJobExecutor(workers=1, capacity=1)
    started = threading.Event()
    release = threading.Event()

    def blocking(_cancel: threading.Event) -> None:
        started.set()
        assert release.wait(timeout=2)

    executor.start()
    try:
        executor.submit("active", blocking)
        assert started.wait(timeout=2)
        executor.submit("queued", lambda _cancel: None)
        with pytest.raises(ConflictError) as raised:
            executor.submit("overflow", lambda _cancel: None)
        assert raised.value.code == "JobQueueFull"
    finally:
        release.set()
        executor.shutdown()


def test_executor_rejects_new_work_after_stopping() -> None:
    executor = BoundedJobExecutor(workers=1, capacity=1)
    executor.start()
    executor.stop_accepting()
    try:
        with pytest.raises(ConflictError) as raised:
            executor.submit("late", lambda _cancel: None)
        assert raised.value.code == "BackendStopping"
    finally:
        executor.shutdown()


def test_process_runner_timeout_terminates_controlled_process() -> None:
    command = [sys.executable, "-c", "import time; getattr(time, 'sleep')(10)"]
    with pytest.raises(DependencyError) as raised:
        ProcessRunner().run(command, timeout_seconds=0.05)
    assert raised.value.code == "ProcessTimeout"


def test_process_runner_honors_cancellation() -> None:
    cancel = threading.Event()
    cancel.set()
    command = [sys.executable, "-c", "import time; getattr(time, 'sleep')(10)"]
    with pytest.raises(DomainError) as raised:
        ProcessRunner().run(command, timeout_seconds=2, cancel=cancel)
    assert raised.value.code == "ProcessCancelled"


def test_path_boundary_accepts_child_and_rejects_escape(tmp_path: Path) -> None:
    root = tmp_path / "owned"
    child = root / "nested" / "file.bin"
    outside = tmp_path / "outside.bin"
    root.mkdir()
    assert ensure_within(child, root) == child.resolve()
    with pytest.raises(DomainError) as raised:
        ensure_within(outside, root)
    assert raised.value.code == "PathOutsideAllowedRoot"


@pytest.mark.parametrize("value", ["../escape", "/absolute", "a/../../escape"])
def test_safe_relative_path_rejects_unsafe_values(value: str) -> None:
    with pytest.raises(DomainError) as raised:
        safe_relative_path(value)
    assert raised.value.code == "InvalidPath"
