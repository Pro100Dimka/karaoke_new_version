"""Bounded render parallelism must preserve ordering and temporary-file lifetimes."""

from concurrent.futures import ThreadPoolExecutor
import threading

import pytest

from backend.domain_errors import DomainError
from backend.recordings import studio_parallel as parallel


@pytest.fixture(autouse=True)
def available_workers(monkeypatch):
    monkeypatch.setattr(parallel, "logical_cpu_count", lambda: 8)


def test_map_uses_workers_but_returns_input_order():
    barrier = threading.Barrier(3)
    identities = set()

    def work(value):
        identities.add(threading.get_ident())
        barrier.wait(timeout=3)
        return value * value

    with parallel.render_execution(threading.Event(), workers=3):
        assert list(parallel.ordered_map(work, range(3))) == [0, 1, 4]
    assert len(identities) == 3


def test_map_does_not_eagerly_read_the_whole_track():
    consumed = []

    def source():
        for value in range(100):
            consumed.append(value)
            yield value

    with parallel.render_execution(threading.Event(), workers=2):
        result = parallel.ordered_map(lambda value: value, source())
        assert next(result) == 0
        assert len(consumed) <= 4
        result.close()


def test_nested_map_runs_on_the_current_worker_without_deadlock():
    def nested(value):
        identity = threading.get_ident()
        return list(parallel.ordered_map(lambda _: threading.get_ident(), [value])) == [identity]

    with parallel.render_execution(threading.Event(), workers=2):
        assert all(parallel.ordered_map(nested, range(8)))


def test_cancelled_render_never_starts_or_consumes_work():
    cancel = threading.Event()
    cancel.set()
    consumed = []
    with pytest.raises(DomainError, match="cancelled"):
        with parallel.render_execution(cancel, workers=2):
            list(parallel.ordered_map(lambda value: consumed.append(value), range(5)))
    assert consumed == []


def test_failure_drains_running_writers_before_scope_exit():
    barrier, finished = threading.Barrier(2), threading.Event()

    def worker(value):
        barrier.wait(timeout=3)
        if value == 0:
            raise ValueError("render failure")
        finished.set()
        return value

    with pytest.raises(ValueError, match="render failure"):
        with parallel.render_execution(threading.Event(), workers=2):
            list(parallel.ordered_map(worker, range(2)))
    assert finished.is_set()


def test_worker_budget_keeps_application_headroom(monkeypatch):
    monkeypatch.setattr(parallel, "logical_cpu_count", lambda: 8)
    created = []

    def executor(*args, **kwargs):
        created.append(kwargs["max_workers"])
        return ThreadPoolExecutor(*args, **kwargs)

    monkeypatch.setattr(parallel, "ThreadPoolExecutor", executor)
    with parallel.render_execution(threading.Event(), workers=500):
        assert list(parallel.ordered_map(str, range(3))) == ["0", "1", "2"]
    assert created == [6]


def test_standalone_and_single_worker_maps_keep_serial_behavior():
    identity = threading.get_ident()
    assert list(parallel.ordered_map(lambda _: threading.get_ident(), range(2))) == [identity] * 2
    with parallel.render_execution(threading.Event(), workers=1):
        assert (
            list(parallel.ordered_map(lambda _: threading.get_ident(), range(2))) == [identity] * 2
        )


def test_production_render_owns_shared_workers_before_processing(tmp_path, monkeypatch):
    from backend.recordings import studio_render

    observed, directories = [], []
    identity = threading.get_ident()
    render = studio_render.MasterRender(
        None,
        tmp_path,
        tmp_path,
        tmp_path,
        tmp_path,
        tmp_path / "master.wav",
        threading.Event(),
        tmp_path,
        True,
        True,
        False,
        (),
        None,
    )

    def stage(self, *args):
        directories.append(self.work)
        observed.extend(parallel.ordered_map(lambda _: threading.get_ident(), range(2)))

    monkeypatch.setattr(studio_render.MasterRender, "_validate_destination", lambda self: None)
    monkeypatch.setattr(studio_render.MasterRender, "_stage", stage)
    monkeypatch.setattr(studio_render.MasterRender, "_analyze", lambda self: None)
    monkeypatch.setattr(studio_render.MasterRender, "_balance_report", lambda self: "done")
    monkeypatch.setattr(studio_render, "apply_reference_pitch", lambda self: {})
    assert render.run() == "done"
    assert observed and identity not in observed
    assert directories and all(not path.exists() for path in directories)


def test_source_level_profiles_share_workers_without_changing_channel_statistics(
    tmp_path, monkeypatch
):
    from types import SimpleNamespace
    import numpy as np
    from backend.recordings import studio_render

    barrier = threading.Barrier(4)
    paths = [tmp_path / str(index) for index in range(4)]
    values = {path: np.array([-30.0, -20.0, -10.0]) + index for index, path in enumerate(paths)}

    def profile(path, cancel):
        barrier.wait(timeout=3)
        return values[path]

    render = SimpleNamespace(
        vocal=paths[0],
        backing=paths[1],
        cancel=threading.Event(),
        sources=SimpleNamespace(reference_vocal=paths[2], reference_backing=paths[3]),
    )
    monkeypatch.setattr(studio_render, "_profile", profile)
    with parallel.render_execution(render.cancel, workers=4):
        studio_render.MasterRender._analyze(render)
    for actual, path in zip(
        (render.voice_db, render.backing_db, render.reference_db, render.original_db), paths
    ):
        np.testing.assert_array_equal(actual, values[path])
