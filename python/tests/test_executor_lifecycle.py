import threading

import pytest

from backend.infrastructure.job_executor import BoundedJobExecutor


@pytest.mark.parametrize("phase", ["submit", "start"])
def test_shutdown_drains_an_in_progress_lifecycle_operation(monkeypatch, phase):
    executor = BoundedJobExecutor(workers=1, capacity=2)
    entered, release, stopped, ran = (threading.Event() for _ in range(4))
    errors = []

    def invoke(action):
        try:
            action()
        except Exception as error:
            errors.append(error)

    def gate(action, *args, **kwargs):
        entered.set()
        assert release.wait(3)
        return action(*args, **kwargs)

    if phase == "submit":
        executor.start()
        enqueue = executor._queue.put_nowait
        monkeypatch.setattr(executor._queue, "put_nowait", lambda task: gate(enqueue, task))

        def action():
            executor.submit("accepted", lambda cancel: ran.set())
    else:
        start = threading.Thread.start

        def gated_start(thread):
            if thread.name.startswith("backend-job-"):
                return gate(start, thread)
            return start(thread)

        monkeypatch.setattr(threading.Thread, "start", gated_start)
        action = executor.start

    def shutdown():
        invoke(executor.shutdown)
        stopped.set()

    operation = threading.Thread(target=lambda: invoke(action))
    closing = threading.Thread(target=shutdown)
    operation.start()
    try:
        assert entered.wait(2)
        closing.start()
        stopped.wait(0.2)  # Give shutdown the blocked operation's intermediate state.
    finally:
        release.set()
        operation.join(3)
        closing.join(3)
        executor.shutdown()
    assert not operation.is_alive() and not closing.is_alive()
    assert errors == []
    if phase == "submit":
        assert ran.is_set(), "An accepted task was stranded behind a shutdown sentinel"
    assert executor.stats()["queued"] == 0


def test_concurrent_shutdown_leaves_no_sentinels_in_a_restarted_executor(monkeypatch):
    executor = BoundedJobExecutor(workers=1, capacity=4)
    active, release, both_stopping = (threading.Event() for _ in range(3))
    sentinels = []
    put = executor._queue.put

    def observe(item, *args, **kwargs):
        if item is None:
            sentinels.append(item)
            if len(sentinels) == 2:
                both_stopping.set()
        return put(item, *args, **kwargs)

    def work(cancel):
        active.set()
        assert release.wait(3)

    monkeypatch.setattr(executor._queue, "put", observe)
    executor.start()
    executor.submit("running", work)
    assert active.wait(2)
    closers = [threading.Thread(target=executor.shutdown) for _ in range(2)]
    try:
        for closer in closers:
            closer.start()
        both_stopping.wait(0.2)
    finally:
        release.set()
        for closer in closers:
            closer.join(3)
    assert all(not closer.is_alive() for closer in closers)
    assert executor.stats()["queued"] == 0
    ran = threading.Event()
    executor.start()
    try:
        executor.submit("after-restart", lambda cancel: ran.set())
        assert ran.wait(2)
    finally:
        executor.shutdown()


@pytest.mark.parametrize("workers,capacity", [(0, 1), (-1, 1), (1, 0), (1, -1)])
def test_executor_requires_positive_bounded_capacity(workers, capacity):
    with pytest.raises(ValueError):
        BoundedJobExecutor(workers, capacity)


def test_partial_worker_start_failure_is_cleaned_up_and_can_be_retried(monkeypatch):
    executor = BoundedJobExecutor(workers=2, capacity=2)
    start = threading.Thread.start
    started = []

    def fail_second(thread):
        if thread.name == "backend-job-1":
            raise RuntimeError("No thread resources")
        started.append(thread)
        start(thread)

    monkeypatch.setattr(threading.Thread, "start", fail_second)
    try:
        with pytest.raises(RuntimeError, match="No thread resources"):
            executor.start()
        assert all(not thread.is_alive() for thread in started)
    finally:
        try:
            executor.shutdown()
        except RuntimeError:
            pass  # Original implementation includes a never-started thread.
    monkeypatch.setattr(threading.Thread, "start", start)
    ran = threading.Event()
    executor.start()
    try:
        executor.submit("retry", lambda cancel: ran.set())
        assert ran.wait(2)
    finally:
        executor.shutdown()


def test_parallel_stage_start_failure_drains_already_started_work(monkeypatch):
    from backend.infrastructure.job_executor import ThreadConcurrentRunner

    start = threading.Thread.start
    release, completed = threading.Event(), threading.Event()
    workers = []

    def fail_second(thread):
        if thread.name == "concurrent-stage-1":
            release.set()
            raise RuntimeError("No thread resources")
        workers.append(thread)
        start(thread)

    def work():
        assert release.wait(2)
        completed.set()

    monkeypatch.setattr(threading.Thread, "start", fail_second)
    try:
        with pytest.raises(RuntimeError, match="No thread resources"):
            ThreadConcurrentRunner().run_concurrently(work, lambda: None)
        assert completed.is_set() and all(not thread.is_alive() for thread in workers)
    finally:
        release.set()
        for thread in workers:
            thread.join(timeout=2)
