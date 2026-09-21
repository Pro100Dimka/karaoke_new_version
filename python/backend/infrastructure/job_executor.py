from __future__ import annotations

import logging
import queue
import threading
from dataclasses import dataclass
from typing import Callable, Mapping

from backend.domain_errors import ConflictError

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class _Task:
    job_id: str
    work: Callable[[threading.Event], None]
    cancel: threading.Event


class BoundedJobExecutor:
    def __init__(self, workers: int, capacity: int) -> None:
        self._workers_count = workers
        self._queue: queue.Queue[_Task | None] = queue.Queue(maxsize=capacity)
        self._tasks: dict[str, _Task] = {}
        self._threads: list[threading.Thread] = []
        self._lock = threading.Lock()
        self._accepting = False

    def start(self) -> None:
        with self._lock:
            if self._threads:
                return
            self._accepting = True
            self._threads = [
                threading.Thread(target=self._worker, name=f"backend-job-{index}", daemon=False)
                for index in range(self._workers_count)
            ]
        for thread in self._threads:
            thread.start()

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
            with self._lock:
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
        with self._lock:
            self._accepting = False

    def shutdown(self) -> None:
        self.stop_accepting()
        with self._lock:
            tasks = tuple(self._tasks.values())
            threads = tuple(self._threads)
        for task in tasks:
            task.cancel.set()
        for _ in threads:
            self._queue.put(None)
        for thread in threads:
            thread.join()
        with self._lock:
            self._threads.clear()
            self._tasks.clear()

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
