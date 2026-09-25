from __future__ import annotations

import logging
import os
import queue
import threading
from dataclasses import dataclass
from typing import Callable, Mapping

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


@dataclass(slots=True)
class _Task:
    job_id: str
    work: Callable[[threading.Event], None]
    cancel: threading.Event


class BoundedJobExecutor:
    def __init__(self, workers: int, capacity: int) -> None:
        if workers < 1 or capacity < 1:
            raise ValueError("Worker count and queue capacity must be positive")
        self._workers_count = workers
        self._queue: queue.Queue[_Task | None] = queue.Queue(maxsize=capacity)
        self._tasks: dict[str, _Task] = {}
        self._threads: list[threading.Thread] = []
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
                        target=self._worker, name=f"backend-job-{index}", daemon=False
                    )
                    thread.start()
                    self._threads.append(thread)
                with self._lock:
                    self._accepting = True
                started = True
            finally:
                if not started:
                    self.shutdown()

    def submit(self, job_id: str, work: Callable[[threading.Event], None]) -> None:
        task = _Task(job_id, work, threading.Event())
        with self._lock:
            if not self._accepting:
                raise ConflictError(
                    "BackendStopping", "Backend is not accepting new background work"
                )
            if job_id in self._tasks:
                raise ConflictError("DuplicateJob", "Job is already registered", jobId=job_id)
            self._tasks[job_id] = task
            try:
                self._queue.put_nowait(task)
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
            for _ in self._threads:
                self._queue.put(None)
            for thread in self._threads:
                thread.join()
            self._threads.clear()

    def stats(self) -> Mapping[str, int]:
        with self._lock:
            active = len(self._tasks)
        return {
            "workers": self._workers_count,
            "activeOrQueued": active,
            "queued": self._queue.qsize(),
            "capacity": self._queue.maxsize,
        }

    def _worker(self) -> None:
        while True:
            task = self._queue.get()
            try:
                if task is None:
                    return
                self._run(task)
            finally:
                self._queue.task_done()

    def _run(self, task: _Task) -> None:
        try:
            task.work(task.cancel)
        except Exception:
            logger.exception("Unhandled background job failure", extra={"jobId": task.job_id})
        finally:
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
