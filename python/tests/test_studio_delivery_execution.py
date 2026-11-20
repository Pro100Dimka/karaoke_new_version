"""Loudness meters share the reserved render budget and keep result ordering."""

from pathlib import Path
import threading

import pytest

from backend.recordings import studio_adaptive_delivery as delivery
from backend.recordings import studio_parallel as parallel


def _measurements():
    return {
        Path("source.wav"): {"integratedLufs": -18.3, "truePeakDbtp": -6.0, "loudnessRangeLu": 7.1},
        Path("reference.wav"): {
            "integratedLufs": -9.3,
            "truePeakDbtp": -1.1,
            "loudnessRangeLu": 3.2,
        },
    }


def test_single_worker_render_keeps_both_meters_inside_reserved_budget(monkeypatch):
    values, calls = _measurements(), []

    def measure(renderer, path, cancel):
        calls.append((path, threading.get_ident()))
        return values[path]

    monkeypatch.setattr(delivery, "measure_loudness", measure)
    cancel = threading.Event()
    with parallel.render_execution(cancel, workers=1):
        actual = delivery._measure_pair(None, *values, cancel)
    assert actual == tuple(values.values())
    assert calls == [(path, threading.get_ident()) for path in values]


def test_two_reserved_workers_meter_concurrently_and_keep_results_ordered(monkeypatch):
    values, workers = _measurements(), set()
    barrier = threading.Barrier(2)

    def measure(renderer, path, cancel):
        workers.add(threading.get_ident())
        barrier.wait(timeout=5)
        return values[path]

    monkeypatch.setattr(delivery, "measure_loudness", measure)
    monkeypatch.setattr(parallel, "logical_cpu_count", lambda: 8)
    cancel = threading.Event()
    with parallel.render_execution(cancel, workers=2):
        actual = delivery._measure_pair(None, *values, cancel)
    assert actual == tuple(values.values())
    assert len(workers) == 2 and threading.get_ident() not in workers


@pytest.mark.parametrize("reference", [None, Path("reference.wav")])
def test_standalone_metering_is_serial_and_preserves_missing_reference(monkeypatch, reference):
    values, calls = _measurements(), []

    def measure(renderer, path, cancel):
        calls.append(threading.get_ident())
        return values[path]

    monkeypatch.setattr(delivery, "measure_loudness", measure)
    actual = delivery._measure_pair(None, Path("source.wav"), reference, threading.Event())
    assert actual == (values[Path("source.wav")], values[reference] if reference else None)
    assert calls == [threading.get_ident()] * (2 if reference else 1)
