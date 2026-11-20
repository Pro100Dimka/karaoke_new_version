"""Independent return jobs retain their serial PCM, calibration and mix order."""

from dataclasses import replace
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.domain_errors import DomainError
from backend.recordings import studio_regional_space as space
from backend.recordings import studio_parallel as execution
from backend.recordings.studio_regional_returns import AmbienceRegion


def _fixture(tmp_path):
    source = tmp_path / "voice.wav"
    samples = np.random.default_rng(319).normal(0, 0.1, (32768 * 2 + 137, 2))
    sf.write(source, samples, 8000, subtype="FLOAT")
    first = AmbienceRegion(
        0.4,
        3.3,
        np.exp(-np.arange(31) / 9),
        (500, 3500),
        1,
        0.15,
        0.01,
        0.8,
        "fixture",
        valid_start=0.1,
        valid_end=8.1,
    )
    regions = [
        first,
        replace(first, start=3.3, end=4.0, existing_ratio=0.2),
        replace(first, start=4.0, end=7.5, ratio=0.12, band_index=0, band=(150, 500)),
    ]
    return source, regions


def test_region_jobs_use_the_shared_ordered_executor(tmp_path, monkeypatch):
    source, regions = _fixture(tmp_path)
    submitted = []

    def observe_map(function, values):
        items = list(values)
        submitted.append(len(items))
        return map(function, items)

    monkeypatch.setattr(space, "ordered_map", observe_map, raising=False)
    buses, reports = space._regional_buses(source, tmp_path, regions, 0.03, [], threading.Event())
    assert [row[1].name for row in buses] == ["ambience-0.wav", "ambience-2.wav"]
    assert [report["decision"] for report in reports] == [
        "estimated-addition",
        "already-present",
        "estimated-addition",
    ]
    assert submitted == [3]


@pytest.mark.parametrize("already_present", [False, True])
def test_no_active_regions_do_not_remeasure_unused_fields(tmp_path, monkeypatch, already_present):
    source, regions = _fixture(tmp_path)
    selected = [regions[1]] if already_present else []
    measured = []
    original = space._field_envelopes

    def observe_fields(path, cancel, **kwargs):
        measured.append(path)
        return original(path, cancel, **kwargs)

    monkeypatch.setattr(space, "_field_envelopes", observe_fields)
    buses, reports = space._regional_buses(source, tmp_path, selected, 0.03, [], threading.Event())
    assert buses == [] and len(reports) == len(selected)
    assert measured == []


def test_empty_regions_still_honor_cancellation(tmp_path):
    source, _ = _fixture(tmp_path)
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(DomainError, match="cancelled"):
        space._regional_buses(source, tmp_path, [], 0.03, [], cancel)


def _serial_buses(voice, work, regions, existing_wet, legacy, cancel):
    """Frozen serial construction before independent return jobs were scheduled."""
    voice_energy = space._field_envelopes(voice, cancel)
    added_energy = space._added_field_energy(legacy, voice_energy, cancel)
    buses, reports = [], []
    for index, region in enumerate(regions):
        if region.ratio <= region.existing_ratio * (1 + 1e-6):
            reports.append(
                {
                    **region.payload(),
                    "midSendGain": 0.0,
                    "sideSendGain": 0.0,
                    "decision": "already-present",
                }
            )
            continue
        path = work / f"ambience-{index}.wav"
        space.convolve_return(
            voice, path, region, space._impulse(region, sf.info(voice).samplerate), cancel
        )
        mid, side = space._calibrate_region(
            voice_energy, path, region, existing_wet, added_energy, cancel
        )
        buses.append(("regional-ambience", path, mid, side))
        reports.append(
            {
                **region.payload(),
                "midSendGain": mid,
                "sideSendGain": side,
                "existingAndAddedMonoWetRatioBound": existing_wet,
                "legacySideEnergyAccounted": bool(legacy),
                "decision": "estimated-addition",
            }
        )
    return buses, reports


def _assert_audio_equal(first, second):
    a, rate_a = sf.read(first, dtype="float32", always_2d=True)
    b, rate_b = sf.read(second, dtype="float32", always_2d=True)
    assert rate_a == rate_b
    np.testing.assert_array_equal(a.view(np.uint32), b.view(np.uint32))


def _assert_buses_equal(actual, expected):
    assert len(actual) == len(expected)
    for first, second in zip(actual, expected, strict=True):
        assert (first[0], first[1].name, first[2:]) == (second[0], second[1].name, second[2:])
        _assert_audio_equal(first[1], second[1])


@pytest.mark.parametrize("workers", [1, 3])
@pytest.mark.parametrize("legacy_present", [False, True])
def test_parallel_buses_keep_serial_pcm_calibration_and_final_mix(
    tmp_path, workers, legacy_present
):
    source, regions = _fixture(tmp_path)
    first, second = tmp_path / "serial", tmp_path / "parallel"
    first.mkdir()
    second.mkdir()
    legacy = [("legacy", source, 0.07)] if legacy_present else []
    cancel = threading.Event()
    expected, expected_report = _serial_buses(source, first, regions, 0.03, legacy, cancel)
    with execution.render_execution(cancel, workers=workers):
        actual, report = space._regional_buses(source, second, regions, 0.03, legacy, cancel)
    _assert_buses_equal(actual, expected)
    assert report == expected_report
    first_mix, second_mix = first / "mix.wav", second / "mix.wav"

    def legacy_duck(block):
        return np.full((len(block), 1), 0.4)

    measured_a = space._mix_buses(source, first_mix, expected, legacy, cancel, legacy_duck)
    measured_b = space._mix_buses(source, second_mix, actual, legacy, cancel, legacy_duck)
    assert measured_a == measured_b
    _assert_audio_equal(first_mix, second_mix)


def test_independent_regions_run_concurrently(tmp_path, monkeypatch):
    source, regions = _fixture(tmp_path)
    barrier, observed = threading.Barrier(2), set()
    convolve = space.convolve_return

    def simultaneous(*args):
        observed.add(threading.get_ident())
        barrier.wait(timeout=5)
        return convolve(*args)

    monkeypatch.setattr(execution, "logical_cpu_count", lambda: 8)
    monkeypatch.setattr(space, "convolve_return", simultaneous)
    cancel = threading.Event()
    with execution.render_execution(cancel, workers=3):
        buses, _ = space._regional_buses(source, tmp_path, regions, 0.03, [], cancel)
    assert len(buses) == len(observed) == 2
