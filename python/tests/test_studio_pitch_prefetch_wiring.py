"""Only local solo pitch starts early; session ownership drains work on every exit."""

from contextlib import nullcontext
from types import SimpleNamespace
import threading

import pytest

from backend.ai.domain import PitchPoint
from backend.recordings.studio_pitch_prefetch import LocalPitchAnalyzer


@pytest.mark.parametrize("failed", [False, True])
def test_pitch_session_yields_local_analyzer_and_closes_it(tmp_path, monkeypatch, failed):
    from backend.recordings import start_studio_master as subject

    calls, closed = [], []
    points = (PitchPoint(0, 440, 0.9, True),)
    source, cancel = tmp_path / "voice.wav", threading.Event()
    context = SimpleNamespace(cancel=cancel, ensure_not_cancelled=lambda: None)
    original = LocalPitchAnalyzer.close

    def close(analyzer):
        closed.append(analyzer)
        original(analyzer)

    def analyze(path, event):
        assert path == source and event is cancel
        calls.append(path)
        return points

    monkeypatch.setattr(subject, "analyze_pitch", analyze)
    monkeypatch.setattr(LocalPitchAnalyzer, "close", close)
    service = subject.StartStudioMaster.__new__(subject.StartStudioMaster)
    with pytest.raises(RuntimeError, match="render failure") if failed else nullcontext():
        with service._pitch_session(context) as analyzer:
            assert isinstance(analyzer, LocalPitchAnalyzer)
            assert not calls and not closed
            assert analyzer(source) == points
            if failed:
                raise RuntimeError("render failure")
    assert calls == [source] and closed == [analyzer]


@pytest.mark.parametrize("kind", ["local", "generic", "disabled"])
@pytest.mark.parametrize("trusted", [False, True])
def test_render_prefetches_only_trusted_local_reference_after_sources(
    tmp_path, monkeypatch, kind, trusted
):
    from backend.recordings import studio_render as subject

    events, cancel = [], threading.Event()
    reference = tmp_path / "mapped-reference.wav"

    def generic(path):
        return ()

    generic.prefetch = lambda path: pytest.fail("Injected callbacks must retain control")
    analyzer = LocalPitchAnalyzer(cancel, generic) if kind == "local" else generic
    if kind == "disabled":
        analyzer = None
    render = subject.MasterRender(
        None,
        tmp_path,
        tmp_path,
        tmp_path,
        tmp_path,
        tmp_path / "master.wav",
        cancel,
        tmp_path,
        True,
        True,
        False,
        (),
        None,
        pitch=analyzer,
    )

    def stage(current, name, *args):
        events.append(name)
        if name == "sources":
            current.sources = SimpleNamespace(reference_vocal=reference if trusted else None)
            current.timing_known = trusted

    monkeypatch.setattr(
        LocalPitchAnalyzer, "prefetch", lambda self, path: events.append(("prefetch", path))
    )
    monkeypatch.setattr(subject.MasterRender, "_validate_destination", lambda self: None)
    monkeypatch.setattr(subject.MasterRender, "_stage", stage)
    monkeypatch.setattr(subject.MasterRender, "_analyze", lambda self: None)
    monkeypatch.setattr(subject.MasterRender, "_balance_report", lambda self: "done")
    monkeypatch.setattr(subject, "apply_reference_pitch", lambda self: {})
    assert render.run() == "done"
    expected = [("prefetch", reference)] if kind == "local" and trusted else []
    assert [value for value in events if isinstance(value, tuple)] == expected
    if expected:
        assert events[:3] == ["sources", expected[0], "arrangement"]
