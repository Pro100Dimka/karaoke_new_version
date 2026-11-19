"""A separate octave return must add the user's voice without replacing the base."""

import threading

import numpy as np
import pytest
import soundfile as sf

from backend.domain_errors import DomainError
from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings import studio_layer_render
from backend.recordings.studio_layer_types import VocalLayerRegion
from backend.recordings.studio_layer_render import render_vocal_layers
from backend.recordings.studio_master import FfmpegStudioMasterRenderer


def voice_fixture(rate, channels=1):
    time = np.arange(rate * 3) / rate
    envelope = np.clip((time - 0.15) / 0.01, 0, 1) * np.clip((2.85 - time) / 0.02, 0, 1)
    voice = envelope * sum(0.06 / h * np.sin(2 * np.pi * 220 * h * time) for h in range(1, 8))
    if channels == 2:
        voice = np.column_stack((voice, voice * 0.7))
    return time, voice


@pytest.mark.parametrize("rate", [44100, 48000])
@pytest.mark.parametrize("semitones", [-12, 12])
@pytest.mark.parametrize("channels", [1, 2])
def test_an_octave_return_is_added_to_an_unchanged_base(tmp_path, rate, semitones, channels):
    time, voice = voice_fixture(rate, channels)
    direct, finished, target = (
        tmp_path / name for name in ("voice.wav", "finished.wav", "out.wav")
    )
    marker = 0.001 * np.sin(2 * np.pi * 5107 * time)
    base = voice + (marker[:, None] if channels == 2 else marker)
    sf.write(direct, voice, rate, subtype="FLOAT")
    sf.write(finished, base, rate, subtype="FLOAT")
    originals = direct.read_bytes(), finished.read_bytes()
    regions = [VocalLayerRegion(0.8, 2.3, "octave", 0.25, semitones=semitones)]

    output, report = render_vocal_layers(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        direct,
        finished,
        target,
        regions,
        threading.Event(),
    )

    actual, actual_rate = sf.read(output, always_2d=True)
    original = sf.read(finished, always_2d=True)[0]
    wet = actual - original
    assert np.max(abs(wet)) > 0.005
    assert report["applied"] is True
    assert actual.shape == original.shape and actual_rate == rate
    outside = (time < 0.8) | (time >= 2.3)
    np.testing.assert_array_equal(actual[outside], original[outside])
    clip = wet[(time > 1.2) & (time < 1.8), 0]
    frequency = np.fft.rfftfreq(131072, 1 / rate)
    spectrum = abs(np.fft.rfft(clip * np.hanning(len(clip)), n=131072))
    expected = 220 * 2 ** (semitones / 12)
    around = (frequency > expected * 0.9) & (frequency < expected * 1.1)
    assert frequency[around][np.argmax(spectrum[around])] == pytest.approx(expected, rel=0.005)
    assert direct.read_bytes() == originals[0] and finished.read_bytes() == originals[1]


@pytest.mark.parametrize("signal", ["silence", "noise"])
def test_unvoiced_input_never_creates_an_octave_voice(tmp_path, signal):
    rate = 48000
    samples = np.zeros(rate * 2)
    if signal == "noise":
        samples = np.random.default_rng(49).normal(0, 0.03, len(samples))
    direct, finished, target = (tmp_path / name for name in ("voice.wav", "base.wav", "out.wav"))
    sf.write(direct, samples, rate, subtype="FLOAT")
    sf.write(finished, samples + 0.001, rate, subtype="FLOAT")
    before = finished.read_bytes()
    output, report = render_vocal_layers(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        direct,
        finished,
        target,
        [VocalLayerRegion(0.1, 1.9, "octave", 0.3, semitones=-12)],
        threading.Event(),
    )
    assert report["applied"] is False
    assert output == finished and finished.read_bytes() == before
    assert not target.exists()


def test_a_consonant_and_silence_inside_a_region_keep_only_the_base(tmp_path):
    rate = 44100
    time, voice = voice_fixture(rate)
    consonant = (time > 1.3) & (time < 1.5)
    silence = (time > 1.8) & (time < 2.1)
    voice[consonant] = np.random.default_rng(20).normal(0, 0.04, np.count_nonzero(consonant))
    voice[silence] = 0
    direct, target = tmp_path / "voice.wav", tmp_path / "out.wav"
    sf.write(direct, voice, rate, subtype="FLOAT")
    output, report = render_vocal_layers(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        direct,
        direct,
        target,
        [VocalLayerRegion(0.4, 2.6, "octave", 0.3, semitones=12)],
        threading.Event(),
    )
    assert report["applied"] is True
    original, actual = sf.read(direct)[0], sf.read(output)[0]
    protected = ((time > 1.36) & (time < 1.44)) | ((time > 1.85) & (time < 2.05))
    np.testing.assert_array_equal(actual[protected], original[protected])


@pytest.mark.parametrize("channels", [1, 2, 4])
def test_invalid_regions_and_unsupported_channels_preserve_the_base(tmp_path, channels):
    rate = 48000
    time, voice = voice_fixture(rate)
    source, target = tmp_path / "voice.wav", tmp_path / "out.wav"
    sf.write(source, np.repeat(voice[:, None], channels, axis=1), rate, subtype="FLOAT")
    regions = [
        VocalLayerRegion(-1, 2, "octave", 0.3, semitones=-12),
        VocalLayerRegion(1, 2, "octave", float("nan"), semitones=-12),
        VocalLayerRegion(1, 2, "octave", 0.3, semitones=7),
        VocalLayerRegion(1, 2, "octave", 0.3, semitones=-12, pan=4),
    ]
    if channels == 4:
        regions.append(VocalLayerRegion(1, 2, "octave", 0.3, semitones=-12))
    before = source.read_bytes()
    output, report = render_vocal_layers(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        source,
        source,
        target,
        regions,
        threading.Event(),
    )
    assert report["applied"] is False and output == source
    assert source.read_bytes() == before and not target.exists()


def test_antiphase_stereo_activity_is_not_cancelled(tmp_path):
    rate = 48000
    _, voice = voice_fixture(rate)
    source, target = tmp_path / "voice.wav", tmp_path / "out.wav"
    sf.write(source, np.column_stack((voice, -voice)), rate, subtype="FLOAT")
    output, report = render_vocal_layers(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        source,
        source,
        target,
        [VocalLayerRegion(0.5, 2.5, "octave", 0.3, semitones=-12)],
        threading.Event(),
    )
    assert report["applied"] is True
    wet = sf.read(output)[0] - sf.read(source)[0]
    assert np.sqrt(np.mean(wet**2)) > 0.002


def test_delayed_layer_cannot_borrow_voice_from_before_its_region(tmp_path):
    rate = 48000
    time, voice = voice_fixture(rate)
    voice[time >= 0.99] = 0
    source, target = tmp_path / "voice.wav", tmp_path / "out.wav"
    sf.write(source, voice, rate, subtype="FLOAT")
    output, report = render_vocal_layers(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        source,
        source,
        target,
        [VocalLayerRegion(1.0, 2.0, "octave", 0.3, semitones=-12, delay_ms=100)],
        threading.Event(),
    )
    assert report["applied"] is False
    np.testing.assert_array_equal(sf.read(output)[0], sf.read(source)[0])


def test_delayed_source_onset_fades_inside_its_region(tmp_path):
    rate = 48000
    time, voice = voice_fixture(rate)
    source, target = tmp_path / "voice.wav", tmp_path / "out.wav"
    sf.write(source, voice, rate, subtype="FLOAT")
    region = VocalLayerRegion(1.001234, 2.5, "octave", 0.4, semitones=-12, delay_ms=100)
    output, report = render_vocal_layers(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        source,
        source,
        target,
        [region],
        threading.Event(),
    )
    wet = sf.read(output)[0] - sf.read(source)[0]
    onset = round((region.start + 0.1) * rate)
    assert np.max(abs(np.diff(wet[onset - 3 : onset + 8]))) < 1e-5
    assert report["applied"] is True
    assert np.sqrt(np.mean(wet[(time > 1.3) & (time < 1.5)] ** 2)) > 0.001


def test_overlapping_returns_have_a_bounded_combined_peak(tmp_path):
    rate = 48000
    _, voice = voice_fixture(rate)
    source, target = tmp_path / "voice.wav", tmp_path / "out.wav"
    sf.write(source, voice, rate, subtype="FLOAT")
    regions = [VocalLayerRegion(0.5, 2.5, "octave", 1, semitones=-12)] * 12
    output, report = render_vocal_layers(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        source,
        source,
        target,
        regions,
        threading.Event(),
    )
    wet = sf.read(output)[0] - sf.read(source)[0]
    assert np.max(abs(wet)) <= np.max(abs(voice)) + 1e-7
    assert 0 < report["wetPeakGain"] < 1


@pytest.mark.parametrize("when", ["before", "analysis", "after-shift"])
def test_cancellation_never_overwrites_the_source_or_publishes_a_partial_return(
    tmp_path, monkeypatch, when
):
    rate = 48000
    _, voice = voice_fixture(rate)
    source, target = tmp_path / "voice.wav", tmp_path / "out.wav"
    sf.write(source, voice, rate, subtype="FLOAT")
    target.write_bytes(b"previous-result")
    original = source.read_bytes()
    cancel = threading.Event()
    if when == "before":
        cancel.set()
    elif when == "analysis":
        read = studio_layer_render._read_context

        def cancel_read(*args):
            result = read(*args)
            cancel.set()
            return result

        monkeypatch.setattr(studio_layer_render, "_read_context", cancel_read)
    else:
        shift = studio_layer_render._shift_octave

        def cancel_shift(*args):
            shift(*args)
            cancel.set()

        monkeypatch.setattr(studio_layer_render, "_shift_octave", cancel_shift)
    with pytest.raises(DomainError, match="cancel"):
        render_vocal_layers(
            FfmpegStudioMasterRenderer(ProcessRunner()),
            source,
            source,
            target,
            [VocalLayerRegion(0.5, 2.5, "octave", 0.3, semitones=-12)],
            cancel,
        )
    assert source.read_bytes() == original and target.read_bytes() == b"previous-result"
    assert not list(tmp_path.glob(".vocal-layers-*"))
