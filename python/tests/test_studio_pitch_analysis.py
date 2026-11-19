"""Ground-truth and boundary checks for the bounded pYIN mastering analyzer."""

import threading

import numpy as np
import pytest
import soundfile as sf

from backend.domain_errors import DependencyError, DomainError


def _signal(rate, seconds, frequency, vibrato=0.0, breath=0.0):
    time = np.arange(round(rate * seconds)) / rate
    hz = frequency * 2 ** (vibrato * np.sin(2 * np.pi * 5 * time) / 12)
    phase = 2 * np.pi * np.cumsum(hz) / rate
    signal = 0.1 * sum(np.sin(h * phase) / h for h in range(1, 6))
    signal += np.random.default_rng(456).normal(0, breath, len(signal))
    return signal, hz


def _write(path, samples, rate):
    sf.write(path, samples, rate, subtype="FLOAT")
    return path


@pytest.mark.parametrize("frequency", [65, 220, 880])
@pytest.mark.parametrize("rate", [16000, 44100])
def test_pyin_retains_clean_notes_with_exact_timestamps(tmp_path, frequency, rate):
    from backend.recordings.studio_pitch_analysis import analyze_pitch

    samples, _ = _signal(rate, 2.011, frequency)
    path = _write(tmp_path / "voice.wav", samples, rate)
    points = analyze_pitch(path, threading.Event())
    times = np.array([p.time for p in points])
    assert len(points) == int(np.ceil(len(samples) / rate * 100))
    np.testing.assert_allclose(times, np.arange(len(points)) / 100, atol=1e-12)
    assert times[-1] < len(samples) / rate
    valid = [p for p in points if p.confidence >= 0.75 and p.frequency > 0 and 0.1 < p.time < 1.9]
    assert len(valid) > 160
    assert (
        np.percentile(abs(1200 * np.log2(np.array([p.frequency for p in valid]) / frequency)), 95)
        < 15
    )
    assert all(p.audio_active for p in valid)


@pytest.mark.parametrize("frequency", [65, 220])
@pytest.mark.parametrize("vibrato,breath", [(0.3, 0), (0, 0.005), (0.3, 0.005)])
def test_pyin_tracks_vibrato_without_quantizing_it_away(tmp_path, frequency, vibrato, breath):
    from backend.recordings.studio_pitch_analysis import analyze_pitch

    rate = 16000
    samples, _ = _signal(rate, 3, frequency, vibrato, breath)
    path = _write(tmp_path / "voice.wav", samples, rate)
    points = analyze_pitch(path, threading.Event())
    valid = [p for p in points if p.frequency > 0 and 0.2 < p.time < 2.8]
    expected = frequency * 2 ** (
        vibrato * np.sin(2 * np.pi * 5 * np.array([p.time for p in valid])) / 12
    )
    errors = abs(1200 * np.log2(np.array([p.frequency for p in valid]) / expected))
    assert len(valid) > 200
    assert np.median(errors) < 10 and np.percentile(errors, 95) < 22


def test_pyin_has_no_gap_or_duplicate_at_streaming_boundaries(tmp_path, monkeypatch):
    from backend.recordings import studio_pitch_analysis

    monkeypatch.setattr(studio_pitch_analysis, "_CHUNK_SECONDS", 2)
    rate = 44100
    time = np.arange(rate * 6 + 17) / rate
    hz = 180 + time * 12
    samples = 0.08 * np.sin(2 * np.pi * np.cumsum(hz) / rate)
    path = _write(tmp_path / "glide.wav", samples, rate)
    points = studio_pitch_analysis.analyze_pitch(path, threading.Event())
    times = np.array([p.time for p in points])
    np.testing.assert_allclose(np.diff(times), 0.01, atol=1e-12)
    selected = [p for p in points if min(abs(p.time - 2), abs(p.time - 4)) < 0.1]
    assert all(p.frequency > 0 and p.confidence >= 0.75 for p in selected)
    assert max(abs(1200 * np.log2(p.frequency / (180 + p.time * 12))) for p in selected) < 18


def test_antiphase_stereo_is_not_misreported_as_silence(tmp_path):
    from backend.recordings.studio_pitch_analysis import analyze_pitch

    rate = 48000
    samples, _ = _signal(rate, 2, 220)
    path = _write(tmp_path / "antiphase.wav", np.column_stack([samples, -samples]), rate)
    points = analyze_pitch(path, threading.Event())
    valid = [p for p in points if p.frequency > 0 and p.time > 0.1]
    assert len(valid) > 170
    assert np.median([p.frequency for p in valid]) == pytest.approx(220, rel=0.01)


@pytest.mark.parametrize("kind", ["silence", "noise", "polyphonic"])
def test_ineligible_content_cannot_get_a_confident_melody(tmp_path, kind):
    from backend.recordings.studio_pitch_analysis import analyze_pitch

    rate = 16000
    time = np.arange(rate * 3) / rate
    samples = np.zeros(len(time))
    if kind == "noise":
        samples = np.random.default_rng(256).normal(0, 0.1, len(time))
    if kind == "polyphonic":
        samples = 0.1 * np.sin(2 * np.pi * 220 * time) + 0.1 * np.sin(2 * np.pi * 311.127 * time)
    path = _write(tmp_path / "ineligible.wav", samples, rate)
    points = analyze_pitch(path, threading.Event())
    assert sum(p.frequency > 0 for p in points) < 0.03 * len(points)
    assert all(np.isfinite(p.frequency) and np.isfinite(p.confidence) for p in points)
    if kind == "silence":
        assert not any(p.audio_active for p in points)


def test_sub_frame_take_is_safe_and_does_not_invent_voicing(tmp_path):
    from backend.recordings.studio_pitch_analysis import analyze_pitch

    source = _write(tmp_path / "tiny.wav", np.array([0.0, 0.1, -0.1]), 48000)
    points = analyze_pitch(source, threading.Event())
    assert len(points) == 1 and points[0].time == 0
    assert points[0].frequency == 0


def test_pyin_rejects_nonfinite_input(tmp_path):
    from backend.recordings.studio_pitch_analysis import analyze_pitch

    source = _write(tmp_path / "invalid.wav", np.array([0.0, float("nan")]), 16000)
    with pytest.raises(DependencyError, match="finite|invalid"):
        analyze_pitch(source, threading.Event())


def test_pyin_checks_cancellation_after_library_execution(tmp_path, monkeypatch):
    from backend.recordings import studio_pitch_analysis

    rate = 16000
    samples, _ = _signal(rate, 2, 220)
    source = _write(tmp_path / "cancel.wav", samples, rate)
    cancel = threading.Event()
    estimate = studio_pitch_analysis.librosa.pyin

    def cancel_after(*args, **kwargs):
        result = estimate(*args, **kwargs)
        cancel.set()
        return result

    monkeypatch.setattr(studio_pitch_analysis.librosa, "pyin", cancel_after)
    with pytest.raises(DomainError, match="cancel"):
        studio_pitch_analysis.analyze_pitch(source, cancel)


def test_audio_reads_are_bounded_independently_of_duration(tmp_path, monkeypatch):
    from backend.recordings import studio_pitch_analysis

    monkeypatch.setattr(studio_pitch_analysis, "_CHUNK_SECONDS", 2)
    source = _write(tmp_path / "silent-long.wav", np.zeros(16000 * 7), 16000)
    original = sf.SoundFile.read

    def bounded_read(audio, frames=-1, *args, **kwargs):
        assert 0 < frames <= audio.samplerate * 3
        return original(audio, frames, *args, **kwargs)

    monkeypatch.setattr(sf.SoundFile, "read", bounded_read)
    assert len(studio_pitch_analysis.analyze_pitch(source, threading.Event())) == 700
