"""One bounded worker pool per offline render, with deterministic result ordering."""

from __future__ import annotations

from collections import deque
from collections.abc import Callable, Iterable, Iterator
from concurrent.futures import Future, ThreadPoolExecutor, wait
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
import threading
from typing import Generic, TypeVar

from backend.cpu_info import logical_cpu_count
from backend.domain_errors import DomainError
from backend.processing.policies import cpu_threads_with_headroom
from backend.recordings.studio_blas import native_threads

_Input = TypeVar("_Input")
_Output = TypeVar("_Output")


@dataclass(frozen=True, slots=True)
class _Execution:
    cancel: threading.Event
    workers: int
    pool: ThreadPoolExecutor | None


_execution: ContextVar[_Execution | None] = ContextVar("studio_execution", default=None)


def _check_cancel(cancel: threading.Event) -> None:
    if cancel.is_set():
        raise DomainError("ProcessCancelled", "Studio master was cancelled", 499)


@contextmanager
def render_execution(cancel: threading.Event, workers: int | None = None) -> Iterator[None]:
    """Drain every writer before callers clean temporary audio or publish the result."""
    _check_cancel(cancel)
    if _execution.get() is not None:
        yield
        return
    available = cpu_threads_with_headroom(logical_cpu_count())
    count = available if workers is None else max(1, min(workers, available))
    with native_threads():
        pool = (
            ThreadPoolExecutor(max_workers=count, thread_name_prefix="admaster")
            if count > 1
            else None
        )
        token = _execution.set(_Execution(cancel, count, pool))
        try:
            yield
        finally:
            try:
                if pool is not None:
                    pool.shutdown(wait=True, cancel_futures=True)
            finally:
                _execution.reset(token)


def _worker(
    function: Callable[[_Input], _Output], value: _Input, cancel: threading.Event
) -> _Output:
    _check_cancel(cancel)
    # Worker contexts intentionally have no executor: nested maps stay serial.
    result = function(value)
    _check_cancel(cancel)
    return result


def _result(future: Future[_Output], cancel: threading.Event) -> _Output:
    while not future.done():
        _check_cancel(cancel)
        wait((future,), timeout=0.05)
    _check_cancel(cancel)
    return future.result()


def ordered_map(
    function: Callable[[_Input], _Output], values: Iterable[_Input]
) -> Iterator[_Output]:
    """Read at most two batches ahead; keep both results and reductions in source order."""
    execution = _execution.get()
    if execution is None or execution.pool is None:
        for value in values:
            if execution is not None:
                _check_cancel(execution.cancel)
            yield function(value)
        return
    yield from _parallel_map(execution, function, iter(values))


def _parallel_map(
    execution: _Execution, function: Callable[[_Input], _Output], values: Iterator[_Input]
) -> Iterator[_Output]:
    assert execution.pool is not None
    pending: deque[Future[_Output]] = deque()
    try:
        for _ in range(execution.workers * 2):
            _check_cancel(execution.cancel)
            try:
                value = next(values)
            except StopIteration:
                break
            pending.append(execution.pool.submit(_worker, function, value, execution.cancel))
        while pending:
            future = pending[0]
            result = _result(future, execution.cancel)
            pending.popleft()
            yield result
            _check_cancel(execution.cancel)
            try:
                value = next(values)
            except StopIteration:
                continue
            pending.append(execution.pool.submit(_worker, function, value, execution.cancel))
    finally:
        for future in pending:
            future.cancel()
        if pending:
            wait(pending)


class ScheduledMap(Iterator[_Output], Generic[_Input, _Output]):
    """Own eagerly scheduled work even before iteration or after an early error."""

    def __init__(
        self,
        function: Callable[[_Input], _Output],
        values: Iterable[_Input],
        execution: _Execution | None,
        initial_tasks: int | None,
    ) -> None:
        self._function, self._values, self._execution = function, iter(values), execution
        self._pending: deque[Future[_Output]] = deque()
        self._closed = self._exhausted = False
        ready = False
        try:
            if execution is not None and execution.pool is not None:
                maximum = 2 * execution.workers
                self._fill(
                    maximum if initial_tasks is None else max(1, min(initial_tasks, maximum))
                )
            ready = True
        finally:
            if not ready:
                self.close()

    def _fill(self, count: int) -> None:
        execution = self._execution
        assert execution is not None and execution.pool is not None
        while not self._exhausted and len(self._pending) < count:
            _check_cancel(execution.cancel)
            try:
                value = next(self._values)
            except StopIteration:
                self._exhausted = True
                break
            self._pending.append(
                execution.pool.submit(_worker, self._function, value, execution.cancel)
            )

    def __next__(self) -> _Output:
        if self._closed:
            raise StopIteration
        ready = False
        try:
            execution = self._execution
            if execution is None or execution.pool is None:
                if execution is not None:
                    _check_cancel(execution.cancel)
                result = self._function(next(self._values))
            else:
                self._fill(2 * execution.workers)
                if not self._pending:
                    raise StopIteration
                result = _result(self._pending[0], execution.cancel)
                self._pending.popleft()
            ready = True
            return result
        finally:
            if not ready:
                self.close()

    def close(self) -> None:
        self._closed = True
        for future in self._pending:
            future.cancel()
        if self._pending:
            wait(self._pending)
            self._pending.clear()


def schedule_map(
    function: Callable[[_Input], _Output],
    values: Iterable[_Input],
    *,
    initial_tasks: int | None = None,
) -> ScheduledMap[_Input, _Output]:
    """Start independent reference work inside the existing render's CPU budget."""
    return ScheduledMap(function, values, _execution.get(), initial_tasks)
