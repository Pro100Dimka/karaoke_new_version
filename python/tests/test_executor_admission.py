import threading

import pytest

from backend.domain_errors import ConflictError
from backend.infrastructure.job_executor import BoundedJobExecutor


def test_an_independent_admission_can_proceed_while_another_waits():
    executor = BoundedJobExecutor(workers=2, capacity=2)
    waiting, release, independent_ran = (threading.Event() for _ in range(3))

    def wait_for_resources(_cancel):
        waiting.set()
        assert release.wait(3)
        return True

    executor.start()
    try:
        executor.submit("blocked", lambda _cancel: None, admit=wait_for_resources)
        assert waiting.wait(2)
        executor.submit(
            "independent", lambda _cancel: independent_ran.set(), admit=lambda _cancel: True
        )
        assert independent_ran.wait(0.5), "An unrelated admission was unnecessarily serialized"
        assert not release.is_set()
    finally:
        release.set()
        executor.shutdown()


@pytest.mark.parametrize("overflow_needs_admission", [False, True])
@pytest.mark.parametrize("workers", [1, 2])
def test_admission_and_ready_jobs_share_one_pending_capacity(overflow_needs_admission, workers):
    executor = BoundedJobExecutor(workers=workers, capacity=workers + 1)
    running = [threading.Event() for _ in range(workers)]
    admitting = [threading.Event() for _ in range(workers)]

    def work(index, cancel):
        running[index].set()
        assert cancel.wait(3)

    def admit(index, cancel):
        admitting[index].set()
        assert cancel.wait(3)
        return False

    executor.start()
    try:
        for index in range(workers):
            executor.submit(f"running-{index}", lambda cancel, i=index: work(i, cancel))
        assert all(event.wait(2) for event in running)
        for index in range(workers):
            executor.submit(
                f"admission-{index}",
                lambda _cancel: pytest.fail("Not admitted"),
                admit=lambda cancel, i=index: admit(i, cancel),
            )
        assert all(event.wait(2) for event in admitting)
        executor.submit("ready", lambda _cancel: None)
        with pytest.raises(ConflictError) as rejected:
            executor.submit(
                "overflow",
                lambda _cancel: None,
                admit=(lambda _cancel: True) if overflow_needs_admission else None,
            )
        assert rejected.value.code == "JobQueueFull"
        assert executor.stats() == {
            "workers": workers,
            "activeOrQueued": workers * 2 + 1,
            "queued": workers + 1,
            "capacity": workers + 1,
        }
    finally:
        executor.shutdown()
    assert executor.stats()["activeOrQueued"] == executor.stats()["queued"] == 0


@pytest.mark.parametrize("workers", [1, 2])
def test_shutdown_drains_admission_handoffs_before_stopping_workers_and_can_restart(workers):
    executor = BoundedJobExecutor(workers=workers, capacity=workers)
    waiting = [threading.Event() for _ in range(workers)]
    ran, restarted = threading.Event(), threading.Event()
    cancelled = []

    def admit(index, cancel):
        waiting[index].set()
        assert cancel.wait(3)
        return True  # A callback can finish concurrently with shutdown's cancellation request.

    def work(cancel):
        cancelled.append(cancel.is_set())
        ran.set()

    executor.start()
    threads = [*executor._threads, *executor._admission_threads]
    try:
        for index in range(workers):
            executor.submit(
                f"handoff-{index}", work, admit=lambda cancel, i=index: admit(i, cancel)
            )
        assert all(event.wait(2) for event in waiting)
    finally:
        executor.shutdown()
    assert ran.is_set() and cancelled == [True] * workers
    assert all(not thread.is_alive() for thread in threads)
    assert executor.stats()["activeOrQueued"] == executor.stats()["queued"] == 0
    executor.start()
    try:
        executor.submit("restart", lambda _cancel: restarted.set(), admit=lambda _cancel: True)
        assert restarted.wait(2)
    finally:
        executor.shutdown()


def test_admission_and_execution_preserve_their_fifo_order():
    executor = BoundedJobExecutor(workers=1, capacity=4)
    waiting, release, finished = (threading.Event() for _ in range(3))
    admissions, executions = [], []

    def admit(identity, _cancel):
        admissions.append(identity)
        if identity == "first":
            waiting.set()
            assert release.wait(3)
        return True

    def work(identity, _cancel):
        executions.append(identity)
        if identity == "second":
            finished.set()

    executor.start()
    try:
        for identity in ("first", "second"):
            executor.submit(
                identity,
                lambda cancel, i=identity: work(i, cancel),
                admit=lambda cancel, i=identity: admit(i, cancel),
            )
        assert waiting.wait(2)
        assert admissions == ["first"] and not executions
        release.set()
        assert finished.wait(2)
        assert admissions == executions == ["first", "second"]
    finally:
        release.set()
        executor.shutdown()
