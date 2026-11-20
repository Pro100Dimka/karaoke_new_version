"""Regional planning and return calibration share the unmodified voice field."""

from types import SimpleNamespace
import threading

import numpy as np
import soundfile as sf

from backend.recordings import studio_regional_space as space
from backend.recordings import studio_regional_levels as levels
from backend.recordings import studio_parallel as execution
from backend.recordings.studio_regional_returns import AmbienceRegion


def _fixture(tmp_path, monkeypatch):
    rate, count = 8000, 8000 * 8 + 37
    voice, reference = tmp_path / "voice.wav", tmp_path / "reference.wav"
    rng = np.random.default_rng(771)
    direct = rng.normal(0, 0.05, count)
    sf.write(voice, np.column_stack((direct * 0.35, direct)), rate, subtype="FLOAT")
    sf.write(reference, rng.normal(0, 0.1, (count, 2)), rate, subtype="FLOAT")
    end = count / rate
    section = SimpleNamespace(start_seconds=0.0, end_seconds=end, confidence=1.0)
    arrangement = SimpleNamespace(
        frames=count,
        rate=rate,
        duration_seconds=end,
        times=np.arange(0.125, end, 0.25),
        reference_valid=np.ones(len(np.arange(0.125, end, 0.25)), dtype=bool),
        sections=(section,),
    )
    region = AmbienceRegion(
        0.0, end, np.exp(-np.arange(31) / 8), (500, 3500), 1, 0.12, 0.0, 0.9, "fixture"
    )
    monkeypatch.setattr(space, "_global_priors", lambda *args: [None, None])
    monkeypatch.setattr(space, "_candidate_region", lambda *args: region)
    monkeypatch.setattr(space, "plan_coherent_echoes", lambda *args: [])
    return voice, reference, arrangement


def test_planning_and_calibration_measure_the_voice_field_once(tmp_path, monkeypatch):
    voice, reference, arrangement = _fixture(tmp_path, monkeypatch)
    measured, original = [], space._field_envelopes

    def observe(path, cancel, **kwargs):
        measured.append(path)
        return original(path, cancel, **kwargs)

    monkeypatch.setattr(space, "_field_envelopes", observe)
    monkeypatch.setattr(levels, "_field_envelopes", observe)
    report = space.render_regional_sends(
        voice,
        tmp_path / "mix.wav",
        threading.Event(),
        reference=reference,
        arrangement=arrangement,
        base_report={},
        legacy=[],
        existing_wet=0.03,
        legacy_duck=lambda block: np.ones((len(block), 1)),
    )
    assert report["applied"]
    assert measured.count(voice) == 1
    assert measured.count(reference) == 1


def test_pan_exclusion_does_not_change_shared_raw_calibration_field(tmp_path, monkeypatch):
    voice, reference, arrangement = _fixture(tmp_path, monkeypatch)
    cancel = threading.Event()
    expected = space._field_envelopes(voice, cancel)
    fields = levels.RegionalFields()
    regions = space.plan_regional_ambience(voice, reference, arrangement, cancel, fields=fields)
    assert regions and fields.voice is not None
    assert not fields.voice.flags.writeable
    np.testing.assert_array_equal(fields.voice.view(np.uint64), expected.view(np.uint64))
    excluded = space.exclude_instantaneous_pan(voice, fields.voice, arrangement, cancel)
    assert np.any(fields.voice[:, :, 1] > 0)
    assert not np.any(excluded[:, :, 1])
    np.testing.assert_array_equal(fields.voice.view(np.uint64), expected.view(np.uint64))


def test_reference_and_voice_fields_run_concurrently_with_exact_values(tmp_path, monkeypatch):
    voice, reference, _ = _fixture(tmp_path, monkeypatch)
    cancel = threading.Event()
    original = levels._field_envelopes
    expected = [original(path, cancel) for path in (reference, voice)]
    barrier, observed = threading.Barrier(2), set()

    def simultaneous(*args, **kwargs):
        observed.add(threading.get_ident())
        barrier.wait(timeout=5)
        return original(*args, **kwargs)

    monkeypatch.setattr(levels, "_field_envelopes", simultaneous)
    monkeypatch.setattr(execution, "logical_cpu_count", lambda: 8)
    fields = levels.RegionalFields()
    with execution.render_execution(cancel, workers=3):
        actual = fields.measure_pair(voice, reference, cancel)
    assert len(observed) == 2
    for first, second in zip(actual, expected, strict=True):
        np.testing.assert_array_equal(first.view(np.uint64), second.view(np.uint64))


def test_shared_fields_keep_remeasured_pcm_and_report(tmp_path, monkeypatch):
    voice, reference, arrangement = _fixture(tmp_path, monkeypatch)
    original = space._regional_buses
    args = dict(
        reference=reference,
        arrangement=arrangement,
        base_report={},
        legacy=[],
        existing_wet=0.03,
        legacy_duck=lambda block: np.ones((len(block), 1)),
    )

    def remeasured(*paths, **kwargs):
        kwargs.pop("voice_energy", None)
        return original(*paths, **kwargs)

    expected_path, actual_path = tmp_path / "old.wav", tmp_path / "new.wav"
    cancel = threading.Event()
    with monkeypatch.context() as baseline:
        baseline.setattr(space, "_regional_buses", remeasured)
        expected_report = space.render_regional_sends(voice, expected_path, cancel, **args)
    with execution.render_execution(cancel, workers=3):
        actual_report = space.render_regional_sends(voice, actual_path, cancel, **args)
    expected, _ = sf.read(expected_path, dtype="float32", always_2d=True)
    actual, _ = sf.read(actual_path, dtype="float32", always_2d=True)
    np.testing.assert_array_equal(actual.view(np.uint32), expected.view(np.uint32))
    assert actual_report == expected_report
