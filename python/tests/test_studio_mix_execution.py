from pathlib import Path
from dataclasses import replace
from types import SimpleNamespace
import threading

import numpy as np
import pytest

from backend.domain_errors import DomainError
from backend.recordings import studio_adaptive_mix as mix
from backend.recordings import studio_adaptive_space as space
from backend.recordings import studio_parallel as parallel


@pytest.fixture(autouse=True)
def available_workers(monkeypatch):
    monkeypatch.setattr(parallel, "logical_cpu_count", lambda: 8)


@pytest.fixture
def mix_case(tmp_path, monkeypatch):
    vocal, backing = tmp_path / "voice.wav", tmp_path / "original-backing.wav"
    vocal.write_bytes(b"balanced voice")
    backing.write_bytes(b"original backing")
    plan = SimpleNamespace(times=np.array([0.0]), gains=np.array([0.0]), report={"plan": 1})
    arrangement = SimpleNamespace(payload=lambda: {"arrangement": 2})
    inputs = mix.MixInputs(vocal, backing, None, None, None, True, arrangement)
    monkeypatch.setattr(mix, "plan_section_balance", lambda *args: plan)
    monkeypatch.setattr(
        mix, "_write_gain_envelope", lambda a, b, *args: b.write_bytes(a.read_bytes())
    )
    measured, summed = threading.Event(), threading.Event()

    def measure(actual, voice, music, cancel):
        assert actual is plan and voice.read_bytes() == b"balanced voice"
        assert music.read_bytes() == b"ducked backing"
        measured.set()
        return {"measured": 3}

    def sum_stems(renderer, voice, music, target, cancel):
        assert measured.is_set()
        assert voice.read_bytes() == b"spatial voice" and music.read_bytes() == b"ducked backing"
        summed.set()
        target.write_bytes(b"final mix")

    monkeypatch.setattr(mix, "measure_balance", measure)
    monkeypatch.setattr(mix, "_sum_stems", sum_stems)
    return SimpleNamespace(
        inputs=inputs, work=tmp_path, plan=plan, measured=measured, summed=summed
    )


def test_sends_overlap_ducking_and_collect_measurement_before_sum(mix_case, monkeypatch):
    entered, sends_started = threading.Event(), threading.Event()

    def duck(voice, backing, target, cancel):
        entered.set()
        assert sends_started.wait(3), "sends must start before ducking finishes"
        target.write_bytes(b"ducked backing")
        return {"duck": 4}

    def sends(voice, backing, target, cancel, **kwargs):
        assert isinstance(backing, Path)
        assert entered.wait(3)
        assert not backing.exists()
        sends_started.set()
        target.write_bytes(b"spatial voice")
        return {"space": 5}

    monkeypatch.setattr(mix, "duck_backing", duck)
    monkeypatch.setattr(mix, "render_sends", sends)
    with parallel.render_execution(threading.Event(), workers=2):
        report = mix._mix_stages(object(), mix_case.inputs, mix_case.work, threading.Event(), None)
    assert report["balance"] == {"plan": 1, "measured": 3}
    assert report["backingEq"] == {"duck": 4} and report["space"] == {"space": 5}
    assert mix_case.summed.is_set()


@pytest.mark.parametrize("prepared", [None, object()], ids=["without-prefit", "with-prefit"])
def test_mix_sends_only_adds_prefit_keyword_when_a_prepared_reference_exists(
    mix_case, monkeypatch, prepared
):
    inputs = replace(mix_case.inputs, ambience=prepared)
    received = []

    def duck(voice, backing, target, cancel):
        target.write_bytes(b"ducked backing")
        return {"duck": 4}

    def sends(voice, backing, target, cancel, **kwargs):
        assert ("ambience" in kwargs) == (prepared is not None)
        if prepared is not None:
            assert kwargs["ambience"] is prepared
        received.append(kwargs)
        target.write_bytes(b"spatial voice")
        return {"space": 5}

    monkeypatch.setattr(mix, "duck_backing", duck)
    monkeypatch.setattr(mix, "render_sends", sends)
    with parallel.render_execution(threading.Event(), workers=1):
        report = mix._mix_stages(object(), inputs, mix_case.work, threading.Event(), None)
    assert len(received) == 1 and report["space"] == {"space": 5}
    assert mix_case.measured.is_set() and mix_case.summed.is_set()


@pytest.mark.parametrize("workers", [1, 2])
@pytest.mark.parametrize("needs_tempo", [False, True])
def test_backing_ready_can_be_used_repeatedly_with_one_or_more_workers(
    mix_case, monkeypatch, workers, needs_tempo
):
    count = []

    def duck(voice, backing, target, cancel):
        count.append(1)
        target.write_bytes(b"ducked backing")
        return {"duck": 4}

    def sends(voice, backing, target, cancel, *, backing_ready=None, **kwargs):
        if needs_tempo:
            assert backing_ready is not None
            backing_ready()
            backing_ready()
            assert backing.read_bytes() == b"ducked backing"
        target.write_bytes(b"spatial voice")
        return {"space": 5}

    monkeypatch.setattr(mix, "duck_backing", duck)
    monkeypatch.setattr(mix, "render_sends", sends)
    with parallel.render_execution(threading.Event(), workers=workers):
        report = mix._mix_stages(object(), mix_case.inputs, mix_case.work, threading.Event(), None)
    assert count == [1] and mix_case.measured.is_set() and mix_case.summed.is_set()
    assert report["balance"] == {"plan": 1, "measured": 3}


def test_sends_failure_drains_running_backing_before_temp_scope_can_close(mix_case, monkeypatch):
    entered, release, finished = threading.Event(), threading.Event(), threading.Event()
    timer = threading.Timer(0.05, release.set)

    def duck(voice, backing, target, cancel):
        entered.set()
        assert release.wait(3)
        target.write_bytes(b"ducked backing")
        finished.set()
        return {"duck": 4}

    def sends(*args, **kwargs):
        assert entered.wait(3)
        timer.start()
        raise ValueError("send failed")

    monkeypatch.setattr(mix, "duck_backing", duck)
    monkeypatch.setattr(mix, "render_sends", sends)
    try:
        with parallel.render_execution(threading.Event(), workers=2):
            with pytest.raises(ValueError, match="send failed"):
                mix._mix_stages(object(), mix_case.inputs, mix_case.work, threading.Event(), None)
            assert finished.is_set()
            assert not mix_case.summed.is_set()
    finally:
        release.set()
        if timer.ident is not None:
            timer.join()


def test_backing_failure_reaches_caller_before_sum(mix_case, monkeypatch):
    def duck(*args):
        raise ValueError("duck failed")

    def sends(voice, backing, target, cancel, **kwargs):
        target.write_bytes(b"spatial voice")
        return {}

    monkeypatch.setattr(mix, "duck_backing", duck)
    monkeypatch.setattr(mix, "render_sends", sends)
    with parallel.render_execution(threading.Event(), workers=2):
        with pytest.raises(ValueError, match="duck failed"):
            mix._mix_stages(object(), mix_case.inputs, mix_case.work, threading.Event(), None)
    assert not mix_case.summed.is_set()


def test_cancellation_during_sends_drains_backing_before_return(mix_case, monkeypatch):
    entered, release, finished, cancel = (threading.Event() for _ in range(4))

    def duck(voice, backing, target, stop):
        entered.set()
        assert release.wait(3)
        target.write_bytes(b"ducked backing")
        finished.set()
        return {}

    def sends(voice, backing, target, stop, **kwargs):
        assert entered.wait(3)
        cancel.set()
        release.set()
        return {}

    monkeypatch.setattr(mix, "duck_backing", duck)
    monkeypatch.setattr(mix, "render_sends", sends)
    with parallel.render_execution(cancel, workers=2):
        with pytest.raises(DomainError) as failure:
            mix._mix_stages(object(), mix_case.inputs, mix_case.work, cancel, None)
        assert failure.value.code == "ProcessCancelled"
        assert finished.is_set() and not mix_case.summed.is_set()


@pytest.mark.parametrize("amount", [0.0, 0.014, 0.015, 0.16, float("nan")])
def test_plan_waits_for_exact_backing_only_when_tempo_is_required(tmp_path, monkeypatch, amount):
    events = []
    backing = tmp_path / "ducked.wav"
    monkeypatch.setattr(space, "_tail_evidence", lambda *args: (0.0, 0.0, 0))
    monkeypatch.setattr(space, "_delay_plan", lambda *args: (0.25, amount, {}))

    def ready():
        events.append("ready")
        backing.write_bytes(b"ducked backing")

    def tempo(path, cancel):
        assert path == backing and path.read_bytes() == b"ducked backing"
        events.append("tempo")
        return 120.0, 0.9

    monkeypatch.setattr(space, "estimate_tempo", tempo)
    plan = space._plan_sends(
        tmp_path / "voice.wav", backing, None, True, threading.Event(), backing_ready=ready
    )
    assert events == (["ready", "tempo"] if amount >= 0.015 else [])
    assert plan.bpm == (120.0 if amount >= 0.015 else None)


def test_render_sends_forwards_backing_dependency_to_its_plan(tmp_path, monkeypatch):
    source, backing, target = (tmp_path / name for name in ("voice.wav", "music.wav", "wet.wav"))
    source.write_bytes(b"dry voice")
    events = []
    monkeypatch.setattr(space, "_tail_evidence", lambda *args: (0.0, 0.0, 0))
    monkeypatch.setattr(space, "_delay_plan", lambda *args: (0.25, 0.02, {}))
    monkeypatch.setattr(space, "_render_send_buses", lambda *args: ([], 0.0))

    def ready():
        events.append("ready")
        backing.write_bytes(b"ducked backing")

    def tempo(path, cancel):
        assert path.read_bytes() == b"ducked backing"
        events.append("tempo")
        return 120.0, 0.9

    monkeypatch.setattr(space, "estimate_tempo", tempo)
    space.render_sends(source, backing, target, threading.Event(), backing_ready=ready)
    assert events == ["ready", "tempo"] and target.read_bytes() == source.read_bytes()
