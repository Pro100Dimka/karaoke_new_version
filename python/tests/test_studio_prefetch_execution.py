import threading

import pytest

from backend.recordings import studio_parallel as parallel


@pytest.fixture(autouse=True)
def available_workers(monkeypatch):
    monkeypatch.setattr(parallel, "logical_cpu_count", lambda: 8)


def test_scheduled_work_starts_before_results_are_consumed_and_keeps_order():
    started, release = threading.Barrier(3), threading.Event()

    def work(value):
        if value < 2:
            started.wait(timeout=3)
            assert release.wait(3)
        return value * 2

    with parallel.render_execution(threading.Event(), workers=3):
        pending = parallel.schedule_map(work, range(7), initial_tasks=2)
        started.wait(timeout=3)
        release.set()
        assert list(pending) == list(range(0, 14, 2))


def test_prefetch_does_not_eagerly_consume_more_than_its_initial_budget():
    consumed = []

    def source():
        for value in range(100):
            consumed.append(value)
            yield value

    with parallel.render_execution(threading.Event(), workers=3):
        pending = parallel.schedule_map(str, source(), initial_tasks=2)
        assert consumed == [0, 1]
        pending.close()
        assert list(pending) == [] and consumed == [0, 1]


def test_closing_unconsumed_prefetch_drains_all_running_work():
    entered, finished = threading.Event(), threading.Event()

    def work(value):
        entered.set()
        finished.set()
        return value

    with parallel.render_execution(threading.Event(), workers=2):
        pending = parallel.schedule_map(work, [1], initial_tasks=1)
        assert entered.wait(3)
        pending.close()
        assert finished.is_set()
        with pytest.raises(StopIteration):
            next(pending)


def test_prefetch_failure_propagates_and_closes_pending_results():
    def fail(value):
        raise ValueError("pitch failure")

    with parallel.render_execution(threading.Event(), workers=2):
        pending = parallel.schedule_map(fail, range(8))
        with pytest.raises(ValueError, match="pitch failure"):
            next(pending)
        assert list(pending) == []


def test_standalone_prefetch_is_lazy_serial_and_closeable():
    seen = []
    pending = parallel.schedule_map(lambda value: seen.append(value) or value, range(3))
    assert seen == []
    assert next(pending) == 0
    pending.close()
    assert list(pending) == [] and seen == [0]
