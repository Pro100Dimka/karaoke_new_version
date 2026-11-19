from pathlib import Path
from types import SimpleNamespace
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.ai.domain import PitchPoint
from backend.recordings.studio_pitch import _pitch_curve, _preserve_pitch_intervals


def _consonant_curve(gap_frames: int, uncertain_reference: bool):
    times = np.arange(400) / 100
    gap = (times >= 1.9) & (times < 1.9 + gap_frames / 100)
    actual = [
        PitchPoint(t, 440 * 2 ** (1.5 / 12), 1, not missing or uncertain_reference)
        for t, missing in zip(times, gap)
    ]
    reference = [
        PitchPoint(t, 440, 0 if missing and uncertain_reference else 1, True)
        for t, missing in zip(times, gap)
    ]
    render = SimpleNamespace(
        info=SimpleNamespace(duration=4),
        adjustments=[],
        pitch_adjustments=[],
        offset_result=(0, 1),
        reference_origin=0,
    )
    axis, correction, _, _, eligible = _pitch_curve(render, actual, reference)
    return axis, correction, eligible


@pytest.mark.parametrize("gap_frames", [3, 7, 8, 10])
@pytest.mark.parametrize("uncertain_reference", [False, True])
def test_pitch_smoothing_cannot_fill_unvoiced_or_untrusted_intervals(
    gap_frames: int, uncertain_reference: bool
):
    times, correction, eligible = _consonant_curve(gap_frames, uncertain_reference)

    # Confidence/activity is a safety boundary, including short consonants between vowels.
    np.testing.assert_array_equal(correction[~eligible], 0)
    assert np.max(np.abs(correction[(times > 0.5) & (times < 1.5)])) > 0.3
    # Returning to the dry signal must not introduce an abrupt 35-cent command jump.
    assert np.max(np.abs(np.diff(correction))) < 0.08


def test_pitch_render_preserves_short_consonants_and_has_smooth_splices(tmp_path: Path):
    times, correction, _ = _consonant_curve(3, False)
    rate = 16000
    axis = np.arange(rate * 4) / rate
    voice = 0.05 * np.sin(2 * np.pi * 200 * axis)
    consonant = (axis >= 1.9) & (axis < 1.93)
    voice[consonant] = np.random.default_rng(91).normal(0, 0.015, consonant.sum())
    source, candidate = tmp_path / "source.wav", tmp_path / "candidate.wav"
    sf.write(source, voice, rate, subtype="FLOAT")
    # Opposite phase is the worst case for a dry/resynthesized transition.
    sf.write(candidate, -voice, rate, subtype="FLOAT")
    render = SimpleNamespace(vocal=source, work=tmp_path, cancel=threading.Event())

    _preserve_pitch_intervals(render, candidate, times, correction)

    original, _ = sf.read(source)
    actual, sr = sf.read(candidate)
    assert sr == rate and actual.shape == original.shape
    np.testing.assert_array_equal(actual[consonant], original[consonant])
    # Test the splice separately from the intentionally broadband consonant itself.
    changed = np.flatnonzero(np.diff((np.abs(correction) > 0.1).astype(int)))
    for index in changed:
        begin, end = (int(times[index] * rate), int(times[index + 1] * rate) + 1)
        assert np.max(np.abs(np.diff(actual[begin:end]))) < 1.5 * 0.05 * 2 * np.pi * 200 / rate
