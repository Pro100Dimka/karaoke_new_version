"""The production spatial renderer must not stack effects already in a recording."""

import threading

import numpy as np
import pytest
import soundfile as sf
from scipy.signal import fftconvolve

from backend.recordings.studio_space import apply_reference_space


@pytest.mark.parametrize("existing_delay", [0.200125, 0.2015])
def test_render_does_not_duplicate_an_existing_echo_with_measurement_jitter(
    tmp_path, existing_delay
):
    rate = 8000
    dry = np.random.default_rng(42).normal(0, 0.04, rate * 24)
    reference, recorded, output = [tmp_path / f"{name}.wav" for name in ("ref", "raw", "out")]
    for path, delay, gain in [(reference, 0.2, 0.25), (recorded, existing_delay, 0.3)]:
        shift = round(delay * rate)
        signal = dry.copy()
        signal[shift:] += gain * dry[:-shift]
        sf.write(path, signal, rate, subtype="FLOAT")
    before = recorded.read_bytes()

    report = apply_reference_space(
        object(), reference, recorded, recorded, output, threading.Event()
    )

    assert report["reference"]["echo_taps"]
    assert report["recorded"]["echo_taps"]
    assert not report["applied"]["echo_taps"]
    np.testing.assert_array_equal(sf.read(output)[0], sf.read(recorded)[0])
    assert sf.info(output).frames == len(dry)
    assert recorded.read_bytes() == before


def test_render_retains_a_distinct_reference_echo(tmp_path):
    rate = 8000
    dry = np.random.default_rng(42).normal(0, 0.04, rate * 24)
    reference, recorded, output = [tmp_path / f"{name}.wav" for name in ("ref", "raw", "out")]
    for path, delay in [(reference, 0.2), (recorded, 0.12)]:
        shift = round(delay * rate)
        signal = dry.copy()
        signal[shift:] += 0.25 * dry[:-shift]
        sf.write(path, signal, rate, subtype="FLOAT")

    report = apply_reference_space(
        object(), reference, recorded, recorded, output, threading.Event()
    )

    assert any(abs(delay - 0.2) < 0.005 for delay, _ in report["applied"]["echo_taps"])
    added = sf.read(output)[0] - sf.read(recorded)[0]
    assert np.mean(added**2) > 1e-5


def test_render_does_not_stack_a_short_tail_onto_a_longer_existing_room(tmp_path):
    rate = 8000
    rng = np.random.default_rng(42)
    dry = np.zeros(rate * 24)
    for start in range(0, 24, 3):
        dry[start * rate : (start + 1) * rate] = rng.normal(0, 0.1, rate)
    reference, recorded, output = [tmp_path / f"{name}.wav" for name in ("ref", "raw", "out")]
    for path, decay, gain in [(reference, 0.4, 0.3), (recorded, 1.1, 0.1)]:
        time = np.arange(round(decay * rate)) / rate
        impulse = np.random.default_rng(7).normal(size=len(time)) * np.exp(-6.9078 * time / decay)
        impulse /= np.linalg.norm(impulse)
        sf.write(path, dry + gain * fftconvolve(dry, impulse)[: len(dry)], rate, subtype="FLOAT")
    before = recorded.read_bytes()

    report = apply_reference_space(
        object(), reference, recorded, recorded, output, threading.Event()
    )

    assert report["reference"]["decay_count"] >= 3
    assert report["recorded"]["decay_seconds"] > report["reference"]["decay_seconds"]
    assert report["applied"]["reverb_gain"] == 0
    np.testing.assert_array_equal(sf.read(output)[0], sf.read(recorded)[0])
    assert sf.info(output).frames == len(dry)
    assert recorded.read_bytes() == before


@pytest.mark.parametrize("frequency,vibrato", [(100, 0), (100, 2), (220, 0.3)])
@pytest.mark.parametrize("has_echo", [False, True])
def test_sustained_harmonics_and_vibrato_are_not_echo_evidence(
    tmp_path, frequency, vibrato, has_echo
):
    rate = 8000
    time = np.arange(rate * 24) / rate
    phase = 2 * np.pi * np.cumsum(frequency + vibrato * np.sin(2 * np.pi * 5 * time)) / rate
    dry = sum(np.sin(harmonic * phase) / harmonic for harmonic in range(1, 16)) * 0.03
    dry += np.random.default_rng(123).normal(0, 0.002, len(time))
    wet = dry.copy()
    delay = round(0.213 * rate)
    if has_echo:
        wet[delay:] += 0.3 * dry[:-delay]
    reference, recorded, output = [tmp_path / f"{name}.wav" for name in ("ref", "raw", "out")]
    sf.write(reference, wet, rate, subtype="FLOAT")
    sf.write(recorded, dry, rate, subtype="FLOAT")

    report = apply_reference_space(
        object(),
        reference,
        recorded,
        recorded,
        output,
        threading.Event(),
        recorded_is_dry=True,
    )

    if has_echo:
        taps = report["applied"]["echo_taps"]
        assert len(taps) == 1
        assert taps[0][0] == pytest.approx(0.213, abs=0.001)
        assert taps[0][1] > 0.15
        assert np.mean((sf.read(output)[0] - dry) ** 2) > 1e-5
    else:
        assert not report["reference"]["echo_taps"]
        assert report["status"] == "no-supported-addition"
        np.testing.assert_array_equal(sf.read(output)[0], sf.read(recorded)[0])
    assert sf.info(output).frames == len(dry)


@pytest.mark.parametrize("gain", [0.0, 0.12, 0.3])
def test_echo_on_changing_voiced_notes_retains_independent_evidence(tmp_path, gain):
    from backend.recordings.studio_space import analyze_space

    rate = 8000
    time = np.arange(rate * 24) / rate
    notes = [98, 123.47, 130.81, 146.83, 196, 220, 233.08, 164.81]
    pitch = np.take(notes, (time // 1.5).astype(int) % len(notes))
    phase = 2 * np.pi * np.cumsum(pitch + 0.3 * np.sin(2 * np.pi * 5 * time)) / rate
    dry = sum(np.sin(harmonic * phase) / harmonic for harmonic in range(1, 16)) * 0.03
    dry += np.random.default_rng(123).normal(0, 0.002, len(time))
    wet = dry.copy()
    delay = round(0.213 * rate)
    wet[delay:] += gain * dry[:-delay]
    reference = tmp_path / "reference.wav"
    sf.write(reference, wet, rate, subtype="FLOAT")

    profile = analyze_space(reference, threading.Event())

    if gain:
        assert len(profile.echo_taps) == 1
        seconds, measured = profile.echo_taps[0]
        assert seconds == pytest.approx(0.213, abs=0.001)
        assert measured > gain * 0.5
    else:
        assert not profile.echo_taps


def test_echo_validation_honors_cancellation_after_initial_analysis(tmp_path, monkeypatch):
    from backend.domain_errors import DomainError
    import backend.recordings.studio_space_analysis as analysis

    rate = 8000
    dry = np.random.default_rng(71).normal(0, 0.04, rate * 12)
    wet = dry.copy()
    wet[1600:] += 0.3 * dry[:-1600]
    reference = tmp_path / "reference.wav"
    sf.write(reference, wet, rate, subtype="FLOAT")
    cancel = threading.Event()
    read_evidence = analysis._read_evidence

    def cancel_after_analysis(path, event):
        evidence = read_evidence(path, event)
        cancel.set()
        return evidence

    monkeypatch.setattr(analysis, "_read_evidence", cancel_after_analysis)

    with pytest.raises(DomainError, match="cancelled"):
        analysis.analyze_space(reference, cancel)


@pytest.mark.parametrize("frequency", [123.47, 130.81, 146.83])
def test_fft_padding_does_not_create_a_48ms_echo(tmp_path, frequency):
    from backend.recordings.studio_space import analyze_space

    rate = 8000
    time = np.arange(rate * 24) / rate
    phase = 2 * np.pi * np.cumsum(frequency + np.sin(2 * np.pi * 5 * time)) / rate
    dry = sum(np.sin(harmonic * phase) / harmonic for harmonic in range(1, 16)) * 0.03
    reference = tmp_path / "reference.wav"
    sf.write(reference, dry, rate, subtype="FLOAT")

    profile = analyze_space(reference, threading.Event())

    assert not profile.echo_taps


def test_real_48ms_echo_retains_temporal_evidence(tmp_path):
    from backend.recordings.studio_space import analyze_space

    rate = 8000
    dry = np.random.default_rng(37).normal(0, 0.04, rate * 24)
    wet = dry.copy()
    delay = round(0.048 * rate)
    wet[delay:] += 0.3 * dry[:-delay]
    reference = tmp_path / "reference.wav"
    sf.write(reference, wet, rate, subtype="FLOAT")

    profile = analyze_space(reference, threading.Event())

    assert any(abs(seconds - 0.048) < 0.001 and gain > 0.2 for seconds, gain in profile.echo_taps)


def test_echo_at_the_source_period_requires_independent_evidence(tmp_path):
    from backend.recordings.studio_space import analyze_space

    rate = 8000
    time = np.arange(rate * 12) / rate
    dry = sum(np.sin(2 * np.pi * harmonic * 100 * time) / harmonic for harmonic in range(1, 16))
    dry = dry * 0.03 + np.random.default_rng(123).normal(0, 0.002, len(time))
    wet = dry.copy()
    shift = round(0.2 * rate)
    wet[shift:] += 0.3 * dry[:-shift]
    reference = tmp_path / "reference.wav"
    sf.write(reference, wet, rate, subtype="FLOAT")

    profile = analyze_space(reference, threading.Event())

    # The loud periodic waveform dominates the independent noise. This guard
    # deliberately abstains rather than treating its near-perfect recurrence
    # as proof that the user's voice needs another echo.
    assert not profile.echo_taps
