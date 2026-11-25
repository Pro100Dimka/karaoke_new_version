"""Playback state changes with no recorded samples must not block AD Master."""

import threading

import numpy as np
import pytest
import soundfile as sf

from backend.domain_errors import DependencyError
from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_master import FfmpegStudioMasterRenderer
from backend.recordings.studio_sources import prepare_sources, render_timeline


RATE = 8000
FRAMES = RATE * 2


def _point(elapsed, source, speed=1, key=0):
    return {
        "elapsedSeconds": elapsed,
        "sourceSeconds": source,
        "playbackRate": speed,
        "keyShift": key,
    }


@pytest.fixture
def reference(tmp_path):
    source = tmp_path / "reference.wav"
    samples = np.random.default_rng(813).uniform(-0.1, 0.1, (RATE * 6, 2)).astype(np.float32)
    sf.write(source, samples, RATE, subtype="FLOAT")
    return source, samples


def _render(source, target, points):
    coverage = render_timeline(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        source,
        target,
        threading.Event(),
        points,
        frames=FRAMES,
        rate=RATE,
        channels=2,
    )
    samples, rate = sf.read(target, dtype="float32", always_2d=True)
    assert rate == RATE and samples.shape == (FRAMES, 2)
    assert np.isfinite(samples).all()
    return samples, coverage


@pytest.mark.parametrize("pause", [0, 1])
def test_pause_changes_keep_last_acknowledged_source(reference, tmp_path, pause):
    source, samples = reference
    points = [_point(0, 0), _point(pause, 1, 0.9, -2), _point(pause, 2)]
    original = [dict(point) for point in points]
    actual, coverage = _render(source, tmp_path / "take.wav", points)
    boundary = pause * RATE
    expected = np.concatenate(
        (samples[:boundary], samples[2 * RATE : 2 * RATE + FRAMES - boundary])
    )
    np.testing.assert_array_equal(actual, expected)
    assert coverage == 1 and points == original


@pytest.mark.parametrize("elapsed", [2, 2.025, 1e308])
def test_updates_after_audio_cutoff_do_not_add_or_remove_samples(reference, tmp_path, elapsed):
    source, samples = reference
    actual, coverage = _render(
        source, tmp_path / "take.wav", [_point(0, 0), _point(elapsed, 99, 1.25, 7)]
    )
    np.testing.assert_array_equal(actual, samples[:FRAMES])
    assert coverage == 1


@pytest.mark.parametrize("boundary", [0, RATE, FRAMES])
def test_changes_in_same_sample_have_no_empty_audio_segments(reference, tmp_path, boundary):
    source, samples = reference
    points = [
        _point(0, 0),
        _point((boundary - 0.1) / RATE if boundary else 0, 1, 0.9, -2),
        _point((boundary + 0.1) / RATE, 2),
    ]
    actual, coverage = _render(source, tmp_path / "take.wav", points)
    expected = np.concatenate(
        (samples[:boundary], samples[2 * RATE : 2 * RATE + FRAMES - boundary])
    )
    np.testing.assert_array_equal(actual, expected)
    assert coverage == 1


def test_pause_and_stop_updates_preserve_tempo_and_key(reference, tmp_path):
    source, _ = reference
    canonical = [_point(0, 0, 0.75, -3), _point(0.75, 1.5, 1.25, 2)]
    captured = [
        _point(0, 0),
        canonical[0],
        _point(0.75, 1, 0.9, -1),
        canonical[1],
        _point(2, 99, 0.5, -12),
        _point(2.1, 101, 1.5, 12),
    ]
    expected, expected_coverage = _render(source, tmp_path / "canonical.wav", canonical)
    actual, coverage = _render(source, tmp_path / "captured.wav", captured)
    np.testing.assert_array_equal(actual, expected)
    assert coverage == expected_coverage == 1


@pytest.mark.parametrize(
    "invalid",
    [
        {},
        {"playbackRate": 0.49},
        {"keyShift": 13},
        {"sourceSeconds": -1},
        {"elapsedSeconds": float("nan")},
        {"keyShift": True},
        {"playbackRate": "1"},
    ],
)
def test_invalid_changes_still_fail_even_after_audio_cutoff(reference, tmp_path, invalid):
    source, _ = reference
    bad = {**_point(3, 99), **invalid} if invalid else {}
    target = tmp_path / "master.wav"
    with pytest.raises(DependencyError) as failure:
        _render(source, target, [_point(0, 0), bad])
    assert failure.value.code == "StudioMasterTimelineUnavailable"
    assert not target.exists()


def test_reference_coverage_uses_the_same_surviving_states(reference, tmp_path):
    source, samples = reference
    take = tmp_path / "take.wav"
    sf.write(take, samples[:FRAMES], RATE, subtype="FLOAT")
    points = [_point(0, 99), _point(0, 1), _point(1, 99), _point(1, 2), _point(2, 99)]
    prepared = prepare_sources(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        take,
        take,
        source,
        source,
        take,
        tmp_path,
        threading.Event(),
        points,
        exact_stems=True,
    )
    assert prepared.reference_intervals == ((0, 2),)
    assert prepared.report["referenceCoverage"] == 1
    assert prepared.reference_vocal is not None
    np.testing.assert_array_equal(
        sf.read(prepared.reference_vocal, dtype="float32")[0], samples[RATE : 3 * RATE]
    )


@pytest.mark.parametrize("covered", [1.984, 0.75, 0])
def test_native_partial_reference_keeps_known_intervals_and_recorded_backing(
    reference, tmp_path, covered
):
    source, samples = reference
    take = tmp_path / "take.wav"
    captured = samples[:FRAMES]
    sf.write(take, captured, RATE, subtype="FLOAT")
    prepared = prepare_sources(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        take,
        take,
        source,
        source,
        take,
        tmp_path,
        threading.Event(),
        [_point(0, 6 - covered)],
        exact_stems=True,
    )
    assert prepared.reference_intervals == (((0, covered),) if covered else ())
    assert (prepared.reference_vocal is not None) == bool(covered)
    assert prepared.backing == take
    np.testing.assert_array_equal(sf.read(prepared.backing, dtype="float32")[0], captured)
    assert sf.info(prepared.backing).frames == FRAMES
