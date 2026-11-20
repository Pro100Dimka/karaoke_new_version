from __future__ import annotations

import logging
import os
import queue
import threading
from dataclasses import dataclass, field
from contextvars import Context
from typing import Callable, Mapping, Iterator
from contextlib import contextmanager

from backend.domain_errors import ConflictError

logger = logging.getLogger(__name__)


def watch_parent_input(on_eof: Callable[[], None]) -> None:
    """One process-owned reader for Electron's pipe; EOF requests normal server shutdown."""

    def read_parent() -> None:
        try:
            # Raw reads avoid holding Python's buffered-stdin lock during interpreter exit.
            while os.read(0, 1):
                pass
        except OSError:
            pass
        finally:
            on_eof()

    threading.Thread(target=read_parent, name="parent-lifetime", daemon=True).start()


def run_in_background(name: str, work: Callable[[], None]) -> threading.Thread:
    """One owned, one-off daemon thread for start-up work that must not delay the server (such as
    fetching the CUDA build of PyTorch). `work` handles its own failures."""
    thread = threading.Thread(target=work, name=name, daemon=True)
    thread.start()
    return thread


class ServiceLoop:
    """One long-lived, owned thread that repeats ``step`` until stopped, such as a socket receive
    loop. It is not a job: it never ends on its own. ``step`` must return within ``stop_seconds``
    (a receive timeout) so ``stop`` can join it."""

    def __init__(self, name: str, step: Callable[[], None], stop_seconds: float) -> None:
        self._step = step
        self._stop_seconds = stop_seconds
        self._stopping = threading.Event()
        self._thread = threading.Thread(target=self._run, name=name, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stopping.set()
        self._thread.join(timeout=self._stop_seconds * 4)

    def _run(self) -> None:
        while not self._stopping.is_set():
            self._step()


@dataclass(slots=True)
class _Task:
    job_id: str
    work: Callable[[threading.Event], None]
    cancel: threading.Event
    admit: Callable[[threading.Event], bool] | None = None
    context: Context = field(default_factory=Context)
    running: bool = False


class BoundedJobExecutor:
    def __init__(self, workers: int, capacity: int) -> None:
        if workers < 1 or capacity < 1:
            raise ValueError("Worker count and queue capacity must be positive")
        self._workers_count = workers
        self._queue: queue.Queue[_Task | None] = queue.Queue(maxsize=capacity)
        self._admissions: queue.Queue[_Task | None] = queue.Queue(maxsize=capacity)
        self._tasks: dict[str, _Task] = {}
        self._threads: list[threading.Thread] = []
        self._admission_threads: list[threading.Thread] = []
        self._lock = threading.Lock()
        self._lifecycle_lock = threading.RLock()
        self._accepting = False

    def start(self) -> None:
        with self._lifecycle_lock:
            if self._threads:
                return
            started = False
            try:
                for index in range(self._workers_count):
                    thread = threading.Thread(
                        target=self._worker,
                        args=(self._queue, self._run),
                        name=f"backend-job-{index}",
                        daemon=False,
                    )
                    thread.start()
                    self._threads.append(thread)
                for index in range(self._workers_count):
                    admission = threading.Thread(
                        target=self._worker,
                        args=(self._admissions, self._admit),
                        name=f"backend-admission-{index}",
                        daemon=False,
                    )
                    admission.start()
                    self._admission_threads.append(admission)
                with self._lock:
                    self._accepting = True
                started = True
            finally:
                if not started:
                    self.shutdown()

    def submit(
        self,
        job_id: str,
        work: Callable[[threading.Event], None],
        *,
        admit: Callable[[threading.Event], bool] | None = None,
    ) -> None:
        task = _Task(job_id, work, threading.Event(), admit)
        with self._lock:
            if not self._accepting:
                raise ConflictError(
                    "BackendStopping", "Backend is not accepting new background work"
                )
            if job_id in self._tasks:
                raise ConflictError("DuplicateJob", "Job is already registered", jobId=job_id)
            # Both staging queues and the current admission share one pending-work budget.
            if sum(not item.running for item in self._tasks.values()) >= self._queue.maxsize:
                raise ConflictError("JobQueueFull", "Background job queue is full")
            self._tasks[job_id] = task
            try:
                target = self._admissions if admit is not None else self._queue
                target.put_nowait(task)
            except queue.Full as exc:
                self._tasks.pop(job_id, None)
                raise ConflictError("JobQueueFull", "Background job queue is full") from exc

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            task = self._tasks.get(job_id)
        if task is None:
            return False
        task.cancel.set()
        return True

    def stop_accepting(self) -> None:
        with self._lifecycle_lock, self._lock:
            self._accepting = False

    def shutdown(self) -> None:
        with self._lifecycle_lock:
            self.stop_accepting()
            with self._lock:
                tasks = tuple(self._tasks.values())
            for task in tasks:
                task.cancel.set()
            # Admission may still hand accepted jobs to execution. Drain it before stop sentinels.
            for _ in self._admission_threads:
                self._admissions.put(None)
            for thread in self._admission_threads:
                thread.join()
            self._admission_threads.clear()
            for _ in self._threads:
                self._queue.put(None)
            for thread in self._threads:
                thread.join()
            self._threads.clear()

    def stats(self) -> Mapping[str, int]:
        with self._lock:
            active = len(self._tasks)
            queued = sum(not task.running for task in self._tasks.values())
        return {
            "workers": self._workers_count,
            "activeOrQueued": active,
            "queued": queued,
            "capacity": self._queue.maxsize,
        }

    def _worker(self, source: queue.Queue[_Task | None], execute: Callable[[_Task], None]) -> None:
        while True:
            task = source.get()
            try:
                if task is None:
                    return
                execute(task)
            finally:
                source.task_done()

    def _admit(self, task: _Task) -> None:
        admitted = False
        try:
            # One Context owns the lease token across admission, execution and finalization.
            if task.admit is not None and task.context.run(task.admit, task.cancel):
                self._queue.put_nowait(task)
                admitted = True
        except Exception:
            logger.exception("Unhandled job admission failure", extra={"jobId": task.job_id})
        finally:
            if not admitted:
                self._complete(task)

    def _run(self, task: _Task) -> None:
        with self._lock:
            task.running = True
        try:
            task.context.run(task.work, task.cancel)
        except Exception:
            logger.exception("Unhandled background job failure", extra={"jobId": task.job_id})
        finally:
            self._complete(task)

    def _complete(self, task: _Task) -> None:
        with self._lock:
            self._tasks.pop(task.job_id, None)


class ThreadConcurrentRunner:
    """Runs independent steps of an already-running job's own work in parallel (see
    ConcurrentRunner, BuildProcessingDocument). Not job scheduling -- it borrows no worker from
    BoundedJobExecutor's bounded pool, so it cannot deadlock a job that is itself running on one of
    those workers."""

    def run_concurrently(self, *tasks: Callable[[], None]) -> None:
        outcomes: list[BaseException | None] = [None] * len(tasks)

        def run_one(index: int, task: Callable[[], None]) -> None:
            try:
                task()
            except BaseException as exc:  # collected here, re-raised on the caller's thread below
                outcomes[index] = exc

        threads = [
            threading.Thread(target=run_one, args=(index, task), name=f"concurrent-stage-{index}")
            for index, task in enumerate(tasks)
        ]
        try:
            for thread in threads:
                thread.start()
        finally:
            for thread in threads:
                if thread.ident is not None:
                    thread.join()
        for outcome in outcomes:
            if outcome is not None:
                raise outcome


@contextmanager
def job_failure(on_error: Callable[[], None], *, suppress: bool = False) -> Iterator[None]:
    """Report unexpected callback failures at the owning background-work boundary."""
    try:
        yield
    except Exception:
        on_error()
        if not suppress:
            raise
