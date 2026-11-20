"""Arrangement uses idle render workers without moving state writes or lifetime gates."""

from itertools import count
from types import SimpleNamespace
import threading

import pytest

from backend.domain_errors import DomainError
from backend.recordings import studio_parallel as parallel
from backend.recordings import studio_render as subject


@pytest.fixture(autouse=True)
def available_workers(monkeypatch):
    monkeypatch.setattr(parallel, "logical_cpu_count", lambda: 8)


def make_render(tmp_path, monkeypatch, *, workers=2):
    events, directories = [], []
    render = subject.MasterRender(
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
        lambda *args: events.append(("progress", threading.get_ident())),
        workers=workers,
    )

    def sources(current):
        current.backing = current.work / "backing.wav"
        current.backing.touch()
        current.sources = SimpleNamespace(
            reference_vocal=tmp_path / "reference.wav", reference_intervals=((1.0, 3.0),)
        )
        current.timing_known = True
        directories.append(current.work)

    monkeypatch.setattr(subject.MasterRender, "_validate_destination", lambda self: None)
    monkeypatch.setattr(subject.MasterRender, "_prepare_stems", sources)
    monkeypatch.setattr(subject.MasterRender, "_analyze", lambda self: None)
    monkeypatch.setattr(subject.MasterRender, "_align", lambda self: None)
    monkeypatch.setattr(subject.MasterRender, "_prepare_voice", lambda self: None)
    monkeypatch.setattr(subject.MasterRender, "_finish_voice", lambda self: None)
    monkeypatch.setattr(subject.MasterRender, "_deliver", lambda self: None)
    monkeypatch.setattr(subject.MasterRender, "_balance_report", lambda self: "done")
    monkeypatch.setattr(subject, "apply_reference_pitch", lambda self: {})
    return render, events, directories


def test_arrangement_overlaps_preparation_and_publishes_on_the_caller(tmp_path, monkeypatch):
    render, events, directories = make_render(tmp_path, monkeypatch)
    caller, started, prepared = threading.get_ident(), threading.Event(), threading.Event()
    caller_clock, worker_clock = count(step=10), iter((1000.0, 1000.625))
    result = SimpleNamespace(payload=lambda: {"unchanged": True})

    def clock():
        return next(caller_clock if threading.get_ident() == caller else worker_clock)

    def analyze(backing, reference, cancel, *, reference_intervals):
        assert backing == render.backing and reference == render.sources.reference_vocal
        assert cancel is render.cancel and reference_intervals == ((1.0, 3.0),)
        started.set()
        assert prepared.wait(1), "Arrangement blocked the independent preparation stage"
        assert "arrangement" not in render.processing
        return result

    def prepare(current):
        assert started.wait(1)
        prepared.set()

    def finish(current):
        assert current.arrangement is result
        assert current.processing["arrangement"] == {"unchanged": True}
        assert current.stage_seconds["arrangement"] == 0.625
        assert threading.get_ident() == caller

    monkeypatch.setattr(subject, "perf_counter", clock)
    monkeypatch.setattr(subject, "analyze_arrangement", analyze)
    monkeypatch.setattr(subject.MasterRender, "_prepare_voice", prepare)
    monkeypatch.setattr(subject.MasterRender, "_finish_voice", finish)
    assert render.run() == "done"
    assert events and all(identity == caller for _, identity in events)
    assert directories and all(not path.exists() for path in directories)


@pytest.mark.parametrize("cancelled", [False, True])
def test_early_exit_drains_arrangement_before_temporary_audio_is_removed(
    tmp_path, monkeypatch, cancelled
):
    render, _, directories = make_render(tmp_path, monkeypatch)
    started, failed, drained = threading.Event(), threading.Event(), threading.Event()
    closed = []
    original_close = parallel.ScheduledMap.close

    def close(pending):
        closed.append(tuple(path.exists() for path in directories))
        original_close(pending)

    def analyze(backing, *args, **kwargs):
        started.set()
        assert failed.wait(1), "Preparation must run while arrangement is pending"
        assert backing.exists()
        drained.set()
        return SimpleNamespace(payload=lambda: {})

    def prepare(current):
        assert started.wait(1)
        if cancelled:
            current.cancel.set()
        failed.set()
        if not cancelled:
            raise RuntimeError("preparation failed")

    monkeypatch.setattr(subject, "analyze_arrangement", analyze)
    monkeypatch.setattr(subject.MasterRender, "_prepare_voice", prepare)
    monkeypatch.setattr(parallel.ScheduledMap, "close", close)
    error = DomainError if cancelled else RuntimeError
    message = "cancelled" if cancelled else "preparation failed"
    with pytest.raises(error, match=message):
        render.run()
    assert drained.is_set()
    assert closed and all(all(exists) for exists in closed)
    assert directories and all(not path.exists() for path in directories)


def test_arrangement_worker_failure_prevents_vocal_inserts(tmp_path, monkeypatch):
    render, _, directories = make_render(tmp_path, monkeypatch)

    def analyze(*args, **kwargs):
        raise ValueError("invalid arrangement input")

    monkeypatch.setattr(subject, "analyze_arrangement", analyze)
    monkeypatch.setattr(
        subject.MasterRender, "_finish_voice", lambda self: pytest.fail("Invalid arrangement")
    )
    with pytest.raises(ValueError, match="invalid arrangement input"):
        render.run()
    assert directories and all(not path.exists() for path in directories)


def test_single_worker_keeps_arrangement_serial_without_changing_its_result(tmp_path, monkeypatch):
    render, _, _ = make_render(tmp_path, monkeypatch, workers=1)
    caller, calls = threading.get_ident(), []
    result = SimpleNamespace(payload=lambda: {"serial": True})

    def analyze(*args, **kwargs):
        assert threading.get_ident() == caller
        calls.append("arrangement")
        return result

    def finish(current):
        calls.append("inserts")
        assert current.arrangement is result
        assert current.processing["arrangement"] == {"serial": True}

    monkeypatch.setattr(subject, "analyze_arrangement", analyze)
    monkeypatch.setattr(
        subject.MasterRender, "_prepare_voice", lambda self: calls.append("prepare")
    )
    monkeypatch.setattr(subject.MasterRender, "_finish_voice", finish)
    assert render.run() == "done"
    assert calls == ["prepare", "arrangement", "inserts"]
