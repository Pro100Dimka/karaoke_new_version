"""Reference ambience may overlap inserts, but never outlive its source files."""

from types import SimpleNamespace
import threading

import pytest

from backend.domain_errors import DomainError
from backend.recordings import studio_parallel as execution
from backend.recordings import studio_render as subject


@pytest.fixture(autouse=True)
def available_workers(monkeypatch):
    monkeypatch.setattr(execution, "logical_cpu_count", lambda: 8)


def _render(tmp_path, monkeypatch, *, workers=2):
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
        None,
        workers=workers,
    )
    directories = []
    arrangement = SimpleNamespace(frames=8000, rate=8000, payload=lambda: {"unchanged": True})

    def sources(current):
        current.backing = current.work / "backing.wav"
        reference = current.work / "reference.wav"
        reference.write_bytes(b"reference source")
        current.sources = SimpleNamespace(reference_vocal=reference, reference_intervals=())
        current.output_channels = 2
        current.timing_known = True
        directories.append(current.work)

    monkeypatch.setattr(subject.MasterRender, "_validate_destination", lambda self: None)
    monkeypatch.setattr(subject.MasterRender, "_prepare_stems", sources)
    monkeypatch.setattr(subject.MasterRender, "_analyze", lambda self: None)
    monkeypatch.setattr(subject.MasterRender, "_align", lambda self: None)
    monkeypatch.setattr(subject.MasterRender, "_prepare_voice", lambda self: None)
    monkeypatch.setattr(subject.MasterRender, "_balance_report", lambda self: "done")
    monkeypatch.setattr(subject, "analyze_arrangement", lambda *args, **kwargs: arrangement)
    monkeypatch.setattr(subject, "apply_reference_pitch", lambda self: {})
    return render, arrangement, directories


def test_reference_fit_runs_during_inserts_and_is_collected_before_delivery(tmp_path, monkeypatch):
    render, layout, directories = _render(tmp_path, monkeypatch)
    entered, release = threading.Event(), threading.Event()
    caller, observed = threading.get_ident(), []
    prepared = object()

    def prefit(reference, arrangement, cancel, *, channels):
        assert arrangement is layout and channels == 2 and cancel is render.cancel
        assert reference.read_bytes() == b"reference source"
        observed.append(("prefit", threading.get_ident()))
        entered.set()
        assert release.wait(2), "Inserts must proceed while reference analysis runs"
        return prepared

    def inserts(current):
        assert entered.wait(2), "Reference analysis did not overlap independent inserts"
        assert current.processing["arrangement"] == {"unchanged": True}
        observed.append(("inserts", threading.get_ident()))
        release.set()

    def deliver(current):
        assert current._collect_ambience() is prepared
        observed.append(("delivery", threading.get_ident()))

    monkeypatch.setattr(subject, "prepare_reference_ambience", prefit, raising=False)
    monkeypatch.setattr(subject.MasterRender, "_finish_voice", inserts)
    monkeypatch.setattr(subject.MasterRender, "_deliver", deliver)
    assert render.run() == "done"
    assert observed[0][0] == "prefit" and observed[0][1] != caller
    assert observed[1:] == [("inserts", caller), ("delivery", caller)]
    assert directories and all(not path.exists() for path in directories)


@pytest.mark.parametrize("cancelled", [False, True])
def test_foreground_exit_drains_reference_worker_before_deleting_sources(
    tmp_path, monkeypatch, cancelled
):
    render, _, directories = _render(tmp_path, monkeypatch)
    entered, release, finished = (threading.Event() for _ in range(3))

    def prefit(reference, *args, **kwargs):
        entered.set()
        assert release.wait(2)
        assert reference.read_bytes() == b"reference source"
        finished.set()
        return object()

    def inserts(current):
        assert entered.wait(2), "Expected an independently running reference analysis"
        if cancelled:
            current.cancel.set()
        release.set()
        if not cancelled:
            raise ValueError("inserts failed")

    monkeypatch.setattr(subject, "prepare_reference_ambience", prefit, raising=False)
    monkeypatch.setattr(subject.MasterRender, "_finish_voice", inserts)
    monkeypatch.setattr(subject.MasterRender, "_deliver", lambda self: pytest.fail("No output"))
    with pytest.raises(DomainError if cancelled else ValueError):
        render.run()
    assert finished.is_set()
    assert directories and all(not path.exists() for path in directories)


def test_reference_worker_failure_prevents_delivery_publication(tmp_path, monkeypatch):
    render, _, directories = _render(tmp_path, monkeypatch)
    entered = threading.Event()

    def prefit(*args, **kwargs):
        entered.set()
        raise ValueError("invalid reference analysis")

    def inserts(current):
        assert entered.wait(2), "Expected reference preparation before delivery"

    def deliver(current):
        current._collect_ambience()
        pytest.fail("Failed reference analysis must not publish")

    monkeypatch.setattr(subject, "prepare_reference_ambience", prefit, raising=False)
    monkeypatch.setattr(subject.MasterRender, "_finish_voice", inserts)
    monkeypatch.setattr(subject.MasterRender, "_deliver", deliver)
    with pytest.raises(ValueError, match="invalid reference analysis"):
        render.run()
    assert directories and all(not path.exists() for path in directories)


def test_one_worker_keeps_reference_fit_serial_with_identical_result(tmp_path, monkeypatch):
    render, _, _ = _render(tmp_path, monkeypatch, workers=1)
    caller, order, prepared = threading.get_ident(), [], object()

    def prefit(*args, **kwargs):
        assert threading.get_ident() == caller
        order.append("reference")
        return prepared

    def deliver(current):
        assert current._collect_ambience() is prepared
        order.append("delivery")

    monkeypatch.setattr(subject, "prepare_reference_ambience", prefit, raising=False)
    monkeypatch.setattr(subject.MasterRender, "_finish_voice", lambda self: order.append("inserts"))
    monkeypatch.setattr(subject.MasterRender, "_deliver", deliver)
    assert render.run() == "done"
    assert order == ["inserts", "reference", "delivery"]
