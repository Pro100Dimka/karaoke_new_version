"""Recognize supported near-unison vocal layers, not stereo width by itself."""

import threading

import numpy as np
import pytest
import soundfile as sf
from scipy.signal import fftconvolve


def _analyze(*args):
    from backend.recordings.studio_double_analysis import analyze_doubling

    return analyze_doubling(*args)


def _voice(rate=16000, seconds=12):
    time = np.arange(rate * seconds) / rate
    pitch = 150 + 18 * np.sin(2 * np.pi * 0.11 * time) + 2 * np.sin(2 * np.pi * 5 * time)
    phase = 2 * np.pi * np.cumsum(pitch) / rate
    envelope = np.where((time % 1.5) < 0.85, 1.0, 0.0)
    voice = sum(np.sin(h * phase) / h for h in range(1, 14)) * 0.04 * envelope
    return time, voice, envelope


def _reference(kind, rate=16000):
    time, voice, envelope = _voice(rate)
    rng = np.random.default_rng(503)
    if kind == "double":
        region = (time >= 3) & (time < 9)
        left = np.interp(
            time - (0.020 + 0.003 * np.sin(2 * np.pi * 0.37 * time)), time, voice, left=0
        )
        right = np.interp(
            time - (0.027 + 0.003 * np.sin(2 * np.pi * 0.43 * time + 0.9)), time, voice, left=0
        )
        return np.column_stack((voice + 0.25 * left * region, voice + 0.25 * right * region))
    if kind in ("dry", "panned", "moving_pan"):
        pan = 0 if kind == "dry" else 0.2
        if kind == "moving_pan":
            pan = 0.2 * np.sin(2 * np.pi * 0.5 * time)
        return np.column_stack((voice * (1 + pan), voice * (1 - pan)))
    if kind == "phase_width":
        right = np.interp(time - 0.001, time, voice, left=0)
        return np.column_stack((voice, right))
    if kind in ("room", "late_room"):
        length = round(rate * 0.7)
        decay = np.exp(-np.arange(length) / rate * 6.9 / 0.6)
        impulse = rng.normal(size=(length, 2)) * decay[:, None]
        if kind == "late_room":
            impulse[: round(rate * 0.12)] = 0
        impulse *= 0.25 / np.linalg.norm(impulse, axis=0)
        wet = fftconvolve(voice[:, None], impulse, axes=0)[: len(voice)]
        return voice[:, None] + wet
    if kind == "unrelated_voice":
        phase = 2 * np.pi * np.cumsum(230 + 30 * np.sin(2 * np.pi * 0.17 * time)) / rate
        side = sum(np.sin(h * phase) / h for h in range(1, 9)) * 0.012 * envelope
    else:
        side = rng.normal(0, 0.018, len(voice)) * envelope
    return np.column_stack((voice + side, voice - side))


def test_modulated_vocal_double_produces_sustained_supported_regions(tmp_path):
    source = tmp_path / "reference.wav"
    sf.write(source, _reference("double"), 16000, subtype="FLOAT")
    original = source.read_bytes()

    regions, report = _analyze(source, threading.Event())

    assert regions
    assert any(region.start < 6.5 < region.end for region in regions)
    assert all(2.8 <= region.start < region.end <= 9.2 for region in regions)
    assert all(region.kind == "double" and region.end - region.start >= 0.24 for region in regions)
    assert all(region.delay_ms >= region.modulation_ms > 0 for region in regions)
    for position in np.arange(0, 12, 0.01):
        assert sum(r.gain for r in regions if r.start <= position < r.end) <= 0.350001
    assert report["applied"]
    assert report["timingPolicy"] == "estimated-short-double"
    assert source.read_bytes() == original


@pytest.mark.parametrize(
    "kind",
    ["dry", "panned", "moving_pan", "phase_width", "room", "late_room", "unrelated_voice", "noise"],
)
def test_width_room_vibrato_and_unrelated_sources_do_not_authorize_a_double(tmp_path, kind):
    source = tmp_path / "reference.wav"
    sf.write(source, _reference(kind), 16000, subtype="FLOAT")

    regions, report = _analyze(source, threading.Event())

    assert not regions
    assert not report["applied"]


def test_double_decisions_do_not_depend_on_reference_gain(tmp_path):
    reference = _reference("double")
    plans = []
    for scale in (0.1, 1.0):
        source = tmp_path / f"reference-{scale}.wav"
        sf.write(source, reference * scale, 16000, subtype="FLOAT")
        regions, _ = _analyze(source, threading.Event())
        assert regions
        plans.append(regions)
    assert len(plans[0]) == len(plans[1])
    for left, right in zip(*plans):
        assert (left.start, left.end, left.kind) == (right.start, right.end, right.kind)
        assert left.gain == pytest.approx(right.gain, abs=1e-6)


def test_mono_reference_without_independent_layer_evidence_is_preserved(tmp_path):
    source = tmp_path / "mono.wav"
    sf.write(source, _voice()[1], 16000, subtype="FLOAT")
    regions, report = _analyze(source, threading.Event())
    assert not regions and not report["applied"]


def test_nonpositive_pitch_peaks_in_subbass_side_do_not_crash_or_create_layers(tmp_path):
    source = tmp_path / "subbass-side.wav"
    time, voice, envelope = _voice()
    side = 0.012 * envelope * (np.sin(2 * np.pi * 30 * time) + 0.2 * np.sin(2 * np.pi * 250 * time))
    sf.write(source, np.column_stack((voice + side, voice - side)), 16000, subtype="FLOAT")

    regions, report = _analyze(source, threading.Event())

    assert not regions and not report["applied"]


def test_double_analysis_checks_cancellation_and_reads_bounded_context(tmp_path, monkeypatch):
    from backend.domain_errors import DomainError

    source = tmp_path / "reference.wav"
    sf.write(source, _reference("double"), 16000, subtype="FLOAT")
    original = source.read_bytes()
    cancel = threading.Event()
    read = sf.SoundFile.read

    def bounded_read(audio, frames=-1, *args, **kwargs):
        assert 0 < frames <= round(audio.samplerate * 1.5)
        samples = read(audio, frames, *args, **kwargs)
        cancel.set()
        return samples

    monkeypatch.setattr(sf.SoundFile, "read", bounded_read)
    with pytest.raises(DomainError, match="cancel"):
        _analyze(source, cancel)
    assert source.read_bytes() == original
