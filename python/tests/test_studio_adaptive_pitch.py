"""Validated tuning protections retained by the adaptive master.

These reproduce consonant corruption and melodic-but-rough candidate acceptance.
"""

from pathlib import Path
from types import SimpleNamespace
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.ai.domain import PitchPoint
from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_master import FfmpegStudioMasterRenderer
from backend.recordings import studio_pitch
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


def _quality(*args):
    from backend.recordings.studio_pitch_quality import inspect_pitch_timbre

    return inspect_pitch_timbre(*args)


def _voice(rate, frequency, *, vibrato=0.0, breath=0.0, shift=0.0):
    time = np.arange(rate * 4) / rate
    notes = vibrato * np.sin(2 * np.pi * 5 * time) + shift
    pitch = frequency * 2 ** (notes / 12)
    phase = 2 * np.pi * np.cumsum(pitch) / rate
    envelope = 0.8 + 0.15 * np.sin(2 * np.pi * 1.1 * time)
    count = min(30, int(5000 / frequency))
    voice = 0.035 * sum(np.sin(h * phase + 0.2 * h) / h for h in range(1, count + 1))
    voice += np.random.default_rng(57).normal(0, breath, len(time))
    return voice * envelope


def _inputs(tmp_path, frequency=220, *, rate=48000, vibrato=0.0, breath=0.0):
    source, candidate = tmp_path / "source.wav", tmp_path / "candidate.wav"
    voice = _voice(rate, frequency, vibrato=vibrato, breath=breath)
    shifted = _voice(rate, frequency, vibrato=vibrato, breath=breath, shift=-0.25)
    sf.write(source, voice, rate, subtype="FLOAT")
    sf.write(candidate, shifted, rate, subtype="FLOAT")
    times = np.arange(400) / 100
    notes = 69 + 12 * np.log2(frequency / 440) + vibrato * np.sin(2 * np.pi * 5 * times)
    corrected = (times > 0.3) & (times < 3.7)
    return source, candidate, times, notes, notes - 0.25, corrected, threading.Event()


@pytest.mark.parametrize("amount", [0.5, 0.7])
@pytest.mark.parametrize("rate", [44100, 48000])
def test_new_inharmonic_sidebands_cannot_pass_as_an_improved_voice(tmp_path, amount, rate):
    arguments = _inputs(tmp_path, rate=rate)
    source, candidate = arguments[:2]
    voice, _ = sf.read(candidate)
    time = np.arange(len(voice)) / rate
    rough = voice * (1 + amount * np.sin(2 * np.pi * 43 * time))
    rough *= np.linalg.norm(voice) / np.linalg.norm(rough)
    sf.write(candidate, rough, rate, subtype="FLOAT")
    original = source.read_bytes()

    report = _quality(*arguments)

    assert report["accepted"] is False
    assert report["degradedFraction"] > 0.5
    assert source.read_bytes() == original


@pytest.mark.parametrize(
    "frequency,vibrato,breath", [(60, 0.3, 0), (220, 0.3, 0.005), (880, 0.3, 0)]
)
def test_clean_pitch_changes_keep_natural_vibrato_and_breath(tmp_path, frequency, vibrato, breath):
    report = _quality(*_inputs(tmp_path, frequency, vibrato=vibrato, breath=breath))
    assert report["accepted"] is True
    assert report["comparedSeconds"] > 2


@pytest.mark.parametrize("rate", [44100, 48000])
@pytest.mark.parametrize(
    "frequency,vibrato,breath", [(60, 0.3, 0), (220, 0.3, 0.005), (880, 0, 0.005)]
)
def test_clean_real_rubberband_candidates_remain_available(
    tmp_path, rate, frequency, vibrato, breath
):
    arguments = _inputs(tmp_path, frequency, rate=rate, vibrato=vibrato, breath=breath)
    source, _, times, notes, _, corrected, cancel = arguments
    render = SimpleNamespace(
        renderer=FfmpegStudioMasterRenderer(ProcessRunner()),
        work=tmp_path,
        vocal=source,
        cancel=cancel,
        info=sf.info(source),
    )
    correction = -0.23 - 0.09 * np.sin(2 * np.pi * 0.7 * times)
    candidate = studio_pitch._render_correction(render, times, correction)

    report = _quality(source, candidate, times, notes, notes + correction, corrected, cancel)

    assert report["accepted"] is True


def test_quality_is_gain_invariant_and_preserves_antiphase_stereo(tmp_path):
    arguments = _inputs(tmp_path)
    for path in arguments[:2]:
        samples, rate = sf.read(path)
        sf.write(path, np.column_stack((samples, -samples)), rate, subtype="FLOAT")
    source, candidate = arguments[:2]
    shifted, rate = sf.read(candidate)
    sf.write(candidate, shifted * 0.3, rate, subtype="FLOAT")
    assert _quality(*arguments)["accepted"] is True
    assert sf.info(source).channels == sf.info(candidate).channels == 2


def test_unvoiced_or_uncorrected_intervals_do_not_create_a_false_rejection(tmp_path):
    arguments = list(_inputs(tmp_path))
    samples, rate = sf.read(arguments[1])
    time = np.arange(len(samples)) / rate
    outside = (time < 1.0) | (time >= 3.0)
    samples[outside] = np.random.default_rng(80).normal(0, 0.04, outside.sum())
    sf.write(arguments[1], samples, rate, subtype="FLOAT")
    arguments[5] = (arguments[2] > 1.1) & (arguments[2] < 2.9)
    assert _quality(*arguments)["accepted"] is True


def test_quality_reads_bounded_context_and_checks_cancellation(tmp_path, monkeypatch):
    from backend.domain_errors import DomainError

    arguments = _inputs(tmp_path)
    read = sf.SoundFile.read

    def cancel_read(audio, frames=-1, *args, **kwargs):
        assert 0 < frames <= round(audio.samplerate * 1.5)
        result = read(audio, frames, *args, **kwargs)
        arguments[-1].set()
        return result

    monkeypatch.setattr(sf.SoundFile, "read", cancel_read)
    with pytest.raises(DomainError, match="cancel"):
        _quality(*arguments)


@pytest.mark.parametrize("amount", [0.0, 0.7])
def test_main_pitch_requires_clean_audio_and_cleans_candidate(tmp_path, monkeypatch, amount):
    rate, frequency = 48000, 220 * 2 ** (0.8 / 12)
    source, candidate = tmp_path / "source.wav", tmp_path / "candidate.wav"
    reference = tmp_path / "reference.wav"
    time = np.arange(rate * 4) / rate
    sf.write(source, _voice(rate, frequency), rate, subtype="FLOAT")
    sf.write(reference, _voice(rate, 220), rate, subtype="FLOAT")
    shift = -0.35 * (0.8 - 0.35)
    rough = _voice(rate, frequency, shift=shift) * (1 + amount * np.sin(2 * np.pi * 43 * time))
    sf.write(candidate, rough, rate, subtype="FLOAT")

    def points(hz):
        return [PitchPoint(t, hz, 1, True) for t in np.arange(400) / 100]

    tracks = {
        source: points(frequency),
        reference: points(220),
        candidate: points(frequency * 2 ** (shift / 12)),
    }
    calls = []

    def analyze(path):
        calls.append(path)
        return tracks[path]

    render = SimpleNamespace(
        renderer=FfmpegStudioMasterRenderer(ProcessRunner()),
        work=tmp_path,
        vocal=source,
        reference_vocal=reference,
        cancel=threading.Event(),
        info=sf.info(source),
        output_channels=1,
        pitch=analyze,
        timing_known=True,
        reliable=np.ones(40, dtype=bool),
        adjustments=[],
        pitch_adjustments=[],
        offset_result=(0, 1),
        reference_origin=0,
        progress=None,
    )
    monkeypatch.setattr(studio_pitch, "_render_correction", lambda *args: candidate)
    original = source.read_bytes()

    report = studio_pitch.apply_reference_pitch(render)

    assert report["applied"] is (amount == 0)
    assert report["verification"]["timbre"]["accepted"] is (amount == 0)
    assert (render.vocal == source) is (amount != 0)
    assert calls == [source, reference, candidate]
    assert not candidate.exists()
    assert source.read_bytes() == original


def test_cancellation_after_the_final_analysis_batch_is_honored(tmp_path, monkeypatch):
    from backend.domain_errors import DomainError
    from backend.recordings import studio_pitch_quality

    arguments = _inputs(tmp_path)
    measure = studio_pitch_quality._measure

    def cancel_after_final_batch(*args):
        result = measure(*args)
        arguments[-1].set()
        return result

    monkeypatch.setattr(studio_pitch_quality, "_measure", cancel_after_final_batch)
    with pytest.raises(DomainError, match="cancel"):
        _quality(*arguments)
