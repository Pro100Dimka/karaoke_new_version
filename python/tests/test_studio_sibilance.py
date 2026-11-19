"""Band-selective vocal control at recording rates, including meaningful bypasses."""

import threading

import numpy as np
import pytest
import soundfile as sf
from scipy.signal import butter, sosfilt, sosfiltfilt

from backend.domain_errors import DomainError
from backend.recordings import studio_sibilance
from backend.recordings.studio_sibilance import apply_sibilance_control as process


def vocal_case(rate, *, kind="harsh", scale=1.0, duration=None):
    time = np.arange(rate * 4) / rate
    body = sum(
        amplitude * np.sin(2 * np.pi * frequency * time)
        for frequency, amplitude in [(220, 0.035), (440, 0.018), (880, 0.012), (1760, 0.008)]
    )
    envelope = np.zeros_like(time)
    for start, end in [(1.0, 1 + (duration or 0.14)), (2.4, 2.4 + (duration or 0.09))]:
        envelope = np.maximum(
            envelope, np.clip((time - start) / 0.005, 0, 1) * np.clip((end - time) / 0.005, 0, 1)
        )
    noise = sosfilt(
        butter(5, [5000, 9500], btype="bandpass", fs=rate, output="sos"),
        np.random.default_rng(63).normal(size=len(time)),
    )
    noise /= np.sqrt(np.mean(noise**2))
    if kind == "bright":
        high = sum(np.sin(2 * np.pi * 220 * harmonic * time) for harmonic in range(19, 41))
        high *= 0.08 / np.sqrt(np.mean(high**2))
    elif kind == "clean":
        high = np.zeros_like(time)
    else:
        high = noise * (0.08 if kind == "harsh" else 0.004)
    voice = body + envelope * high
    if kind == "breath":
        breath = (time > 1) & (time < 1.5)
        voice[breath] = 0.004 * noise[breath]
    return time, voice * scale


def band_power(samples, rate, band, selection):
    # Filter in full context, so padding a short crop cannot turn HF boundary
    # samples into a spurious low-frequency change at the measurement edges.
    filtered = sosfiltfilt(
        butter(5, band, btype="bandpass", fs=rate, output="sos"), samples, axis=0
    )
    return np.mean(filtered[selection] ** 2)


@pytest.mark.parametrize("rate", [44100, 48000])
@pytest.mark.parametrize("channels", [1, 2])
def test_harsh_bursts_are_reduced_without_ducking_the_vocal_body(tmp_path, rate, channels):
    time, voice = vocal_case(rate)
    if channels == 2:
        voice = np.column_stack((voice, -0.7 * voice))
    source, target = tmp_path / "source.wav", tmp_path / "controlled.wav"
    sf.write(source, voice, rate, subtype="FLOAT")
    original = source.read_bytes()

    output, report = process(source, target, threading.Event())

    actual, actual_rate = sf.read(output)
    middle = (time > 1.035) & (time < 1.105)
    before = band_power(voice, rate, [5200, 9000], middle)
    after = band_power(actual, rate, [5200, 9000], middle)
    reduction = 10 * np.log10(before / after)
    assert 3 <= reduction <= 6.5
    before_body = band_power(voice, rate, [300, 2300], middle)
    after_body = band_power(actual, rate, [300, 2300], middle)
    assert abs(10 * np.log10(after_body / before_body)) < 0.15
    assert actual_rate == rate and actual.shape == voice.shape
    assert np.isfinite(actual).all()
    assert report["applied"] is True
    assert report["affectedSeconds"] > 0.05
    assert 0 < report["maxReductionDb"] <= 6
    assert source.read_bytes() == original
    if channels == 2:
        np.testing.assert_allclose(actual[:, 1], -0.7 * actual[:, 0], atol=2e-7)


@pytest.mark.parametrize("kind", ["clean", "quiet", "breath", "bright"])
@pytest.mark.parametrize("rate", [44100, 48000])
def test_normal_consonants_breaths_and_bright_harmonics_are_preserved(tmp_path, kind, rate):
    _, voice = vocal_case(rate, kind=kind)
    if kind == "clean":
        voice = 0.035 * np.sin(2 * np.pi * 220 * np.arange(len(voice)) / rate)
    source, target = tmp_path / "source.wav", tmp_path / "controlled.wav"
    sf.write(source, voice, rate, subtype="FLOAT")
    original = source.read_bytes()

    output, report = process(source, target, threading.Event())

    assert report["applied"] is False
    assert report["maxReductionDb"] == 0
    np.testing.assert_array_equal(sf.read(output)[0], sf.read(source)[0])
    assert source.read_bytes() == original


def test_sibilance_decisions_are_independent_of_microphone_gain(tmp_path):
    rate = 44100
    outputs = []
    for scale in [0.1, 1.0, 2.0]:
        _, voice = vocal_case(rate, scale=scale)
        source, target = tmp_path / f"source-{scale}.wav", tmp_path / f"out-{scale}.wav"
        sf.write(source, voice, rate, subtype="FLOAT")
        output, report = process(source, target, threading.Event())
        assert report["applied"] is True
        outputs.append(sf.read(output)[0] / scale)
    for output in outputs[1:]:
        np.testing.assert_allclose(output, outputs[0], atol=2e-7)


def test_processed_vowels_return_to_the_original_level_between_bursts(tmp_path):
    rate = 48000
    time, voice = vocal_case(rate)
    source, target = tmp_path / "source.wav", tmp_path / "controlled.wav"
    sf.write(source, voice, rate, subtype="FLOAT")

    output, _ = process(source, target, threading.Event())

    actual, _ = sf.read(output)
    settled = ((time > 0.1) & (time < 0.8)) | ((time > 1.6) & (time < 2.2)) | (time > 3)
    np.testing.assert_allclose(actual[settled], voice[settled], atol=2e-7)


@pytest.mark.parametrize("rate,frames", [(8000, 1000), (48000, 1), (48000, 192000)])
def test_silence_and_insufficient_bandwidth_are_safe(tmp_path, rate, frames):
    source, target = tmp_path / "silence.wav", tmp_path / "controlled.wav"
    sf.write(source, np.zeros((frames, 2)), rate, subtype="FLOAT")
    output, report = process(source, target, threading.Event())
    assert report["applied"] is False
    samples, actual_rate = sf.read(output, always_2d=True)
    assert samples.shape == (frames, 2) and actual_rate == rate
    np.testing.assert_array_equal(samples, 0)


def test_repeated_render_from_the_original_is_deterministic(tmp_path):
    rate = 48000
    _, voice = vocal_case(rate)
    source = tmp_path / "source.wav"
    sf.write(source, voice, rate, subtype="FLOAT")
    first, first_report = process(source, tmp_path / "first.wav", threading.Event())
    second, second_report = process(source, tmp_path / "second.wav", threading.Event())
    assert first_report == second_report
    np.testing.assert_array_equal(sf.read(first)[0], sf.read(second)[0])


@pytest.mark.parametrize("frequency", [40, 50, 65, 80, 110])
def test_dense_low_pitch_harmonics_are_not_mistaken_for_sibilance(tmp_path, frequency):
    rate = 48000
    time, body = vocal_case(rate, kind="clean")
    bright = sum(
        np.sin(2 * np.pi * frequency * harmonic * time + harmonic * 0.31)
        for harmonic in range(int(4000 / frequency), int(10500 / frequency))
    )
    bright *= 0.08 / np.sqrt(np.mean(bright**2))
    envelope = np.clip((time - 1) / 0.005, 0, 1) * np.clip((1.14 - time) / 0.005, 0, 1)
    source, target = tmp_path / "bright.wav", tmp_path / "controlled.wav"
    sf.write(source, body + envelope * bright, rate, subtype="FLOAT")

    output, report = process(source, target, threading.Event())

    assert report["applied"] is False
    np.testing.assert_array_equal(sf.read(output)[0], sf.read(source)[0])


def vibrato_case(rate, frequency, random_phase):
    time = np.arange(rate * 4) / rate
    pitch = frequency * (1 + 0.02 * np.sin(2 * np.pi * 5 * time + 0.7))
    phase = 2 * np.pi * np.cumsum(pitch) / rate
    body = sum(0.04 / h * np.sin(h * phase) for h in range(1, 20))
    harmonics = np.arange(np.ceil(4000 / frequency), np.floor(11000 / frequency) + 1)
    phases = np.random.default_rng(99).uniform(0, 2 * np.pi, len(harmonics))
    if not random_phase:
        phases *= 0
    bright = sum(np.sin(h * phase + p) / h for h, p in zip(harmonics, phases))
    bright *= 0.08 / np.sqrt(np.mean(bright**2))
    envelope = np.clip((time - 1) / 0.005, 0, 1) * np.clip((1.14 - time) / 0.005, 0, 1)
    return body + envelope * bright


@pytest.mark.parametrize("frequency", [55, 80, 110])
@pytest.mark.parametrize("random_phase", [False, True])
def test_bright_bass_vibrato_keeps_its_harmonics(tmp_path, frequency, random_phase):
    rate = 48000
    voice = vibrato_case(rate, frequency, random_phase)
    source, target = tmp_path / "vibrato.wav", tmp_path / "controlled.wav"
    sf.write(source, voice, rate, subtype="FLOAT")

    output, report = process(source, target, threading.Event())

    assert report["applied"] is False
    np.testing.assert_array_equal(sf.read(output)[0], sf.read(source)[0])


@pytest.mark.parametrize("duration", [0.05, 0.09, 0.15])
@pytest.mark.parametrize("rate", [44100, 48000])
def test_short_noisy_bursts_still_receive_selective_reduction(tmp_path, duration, rate):
    time, voice = vocal_case(rate, duration=duration)
    source, target = tmp_path / "short.wav", tmp_path / "controlled.wav"
    sf.write(source, voice, rate, subtype="FLOAT")
    output, report = process(source, target, threading.Event())
    actual = sf.read(output)[0]
    middle = (time > 1 + duration * 0.3) & (time < 1 + duration * 0.7)
    before = band_power(voice, rate, [5200, 9000], middle)
    after = band_power(actual, rate, [5200, 9000], middle)
    assert report["applied"] is True
    assert 3 <= 10 * np.log10(before / after) <= 6.5
    before_body = band_power(voice, rate, [300, 2300], middle)
    after_body = band_power(actual, rate, [300, 2300], middle)
    assert abs(10 * np.log10(after_body / before_body)) < 0.15


def test_a_short_noise_burst_amid_bright_voicing_is_still_controlled(tmp_path):
    rate = 48000
    time, voice = vocal_case(rate, duration=0.09)
    bright = sum(np.sin(2 * np.pi * 220 * h * time + h * 0.31) for h in range(19, 50))
    bright *= 0.025 / np.sqrt(np.mean(bright**2))
    voice += bright
    source, target = tmp_path / "bright-sibilant.wav", tmp_path / "controlled.wav"
    sf.write(source, voice, rate, subtype="FLOAT")

    output, report = process(source, target, threading.Event())

    actual = sf.read(output)[0]
    middle = (time > 1.03) & (time < 1.06)
    before = band_power(voice, rate, [5200, 9000], middle)
    after = band_power(actual, rate, [5200, 9000], middle)
    assert report["applied"] is True
    assert 1 <= 10 * np.log10(before / after) <= 6.5
    settled = ((time > 0.1) & (time < 0.8)) | (time > 3)
    np.testing.assert_allclose(actual[settled], voice[settled], atol=2e-7)


def test_chunk_boundaries_do_not_change_the_audio(tmp_path, monkeypatch):
    rate = 44100
    _, voice = vocal_case(rate)
    source = tmp_path / "source.wav"
    sf.write(source, voice, rate, subtype="FLOAT")
    first, first_report = process(source, tmp_path / "large.wav", threading.Event())
    monkeypatch.setattr(studio_sibilance, "_BLOCK_FRAMES", 4096)
    second, second_report = process(source, tmp_path / "small.wav", threading.Event())
    assert first_report == second_report
    np.testing.assert_allclose(sf.read(first)[0], sf.read(second)[0], atol=2e-8)


@pytest.mark.parametrize("during", ["before", "analysis", "render"])
def test_cancellation_preserves_the_source_and_reads_are_bounded(tmp_path, monkeypatch, during):
    rate = 48000
    _, voice = vocal_case(rate)
    source, target = tmp_path / "source.wav", tmp_path / "controlled.wav"
    sf.write(source, voice, rate, subtype="FLOAT")
    original = source.read_bytes()
    cancel = threading.Event()
    read = sf.SoundFile.read

    def bounded_read(audio, frames=-1, *args, **kwargs):
        assert 0 <= frames <= 65536 + 512
        samples = read(audio, frames, *args, **kwargs)
        if during == "analysis" or (during == "render" and frames > 65536):
            cancel.set()
        return samples

    monkeypatch.setattr(sf.SoundFile, "read", bounded_read)
    if during == "before":
        cancel.set()
    with pytest.raises(DomainError, match="cancel"):
        process(source, target, cancel)
    assert source.read_bytes() == original
    if during != "render":
        assert not target.exists()
