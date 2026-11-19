"""A full-length reference copy needs only one analysis within the current master."""

import os
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.domain_errors import DomainError
from backend.recordings import studio_space
from backend.recordings.studio_space_analysis import SpaceProfile


def _tail_analysis(monkeypatch):
    calls = []
    complete = SpaceProfile(decay_seconds=1.2, reverb_gain=0.3, decay_count=5)

    def analyze(path, cancel):
        calls.append(path)
        return complete

    monkeypatch.setattr(studio_space, "analyze_space", analyze)
    return calls, complete


@pytest.mark.parametrize("rate", [44100, 48000])
@pytest.mark.parametrize("channels", [1, 2])
@pytest.mark.parametrize(
    "suffix,subtype",
    [(".wav", "PCM_16"), (".wav", "PCM_24"), (".wav", "FLOAT"), (".flac", "PCM_24")],
)
def test_same_decoded_pcm_reuses_the_current_scoped_analysis(
    tmp_path, monkeypatch, rate, channels, suffix, subtype
):
    full, scoped = tmp_path / ("full" + suffix), tmp_path / "scoped.wav"
    samples = np.random.default_rng(52).normal(0, 0.03, (rate * 2, channels))
    sf.write(full, samples, rate, subtype=subtype)
    decoded, _ = sf.read(full, always_2d=True)
    sf.write(scoped, decoded, rate, subtype="FLOAT")
    original = [path.read_bytes() for path in (full, scoped)]
    expected = SpaceProfile(duration=2, decay_count=2, stereo_width=0.15)
    calls, _ = _tail_analysis(monkeypatch)

    actual, source = studio_space._reference_tail(expected, full, scoped, threading.Event())

    assert actual is expected
    assert source == "performed-section"
    assert calls == []
    assert [path.read_bytes() for path in (full, scoped)] == original


@pytest.mark.parametrize(
    "difference", ["rate", "channels", "frames", "last-sample", "float32-rounding"]
)
def test_any_pcm_or_format_difference_preserves_full_song_tail_analysis(
    tmp_path, monkeypatch, difference
):
    full, scoped = tmp_path / "full.wav", tmp_path / "scoped.wav"
    samples = np.full((131073, 1), 0.25)
    if difference == "float32-rounding":
        samples[-1, 0] += 2**-31
    sf.write(full, samples, 44100, subtype="PCM_32")
    selected = samples.copy()
    rate = 48000 if difference == "rate" else 44100
    if difference == "channels":
        selected = np.repeat(selected, 2, axis=1)
    elif difference == "frames":
        selected = selected[:-1]
    elif difference == "last-sample":
        selected[-1, 0] -= 2**-23
    sf.write(scoped, selected, rate, subtype="FLOAT")
    expected = SpaceProfile(duration=len(selected) / rate, echo_taps=((0.2, 0.1),))
    calls, complete = _tail_analysis(monkeypatch)

    actual, source = studio_space._reference_tail(expected, full, scoped, threading.Event())

    assert calls == [full]
    assert source == "full-song"
    assert actual.reverb_gain == complete.reverb_gain
    assert actual.decay_seconds == complete.decay_seconds
    assert actual.echo_taps == expected.echo_taps


def test_reference_identity_is_not_reused_after_same_size_and_mtime_pcm_change(
    tmp_path, monkeypatch
):
    full, scoped = tmp_path / "full.wav", tmp_path / "scoped.wav"
    samples = np.full(131073, 0.25)
    for path in (full, scoped):
        sf.write(path, samples, 44100, subtype="PCM_24")
    expected = SpaceProfile(duration=len(samples) / 44100)
    calls, complete = _tail_analysis(monkeypatch)
    _, source = studio_space._reference_tail(expected, full, scoped, threading.Event())
    assert source == "performed-section" and not calls
    before = full.stat()
    samples[-1] += 2**-23
    sf.write(full, samples, 44100, subtype="PCM_24")
    os.utime(full, ns=(before.st_atime_ns, before.st_mtime_ns))
    assert full.stat().st_size == before.st_size
    assert full.stat().st_mtime_ns == before.st_mtime_ns

    actual, source = studio_space._reference_tail(expected, full, scoped, threading.Event())

    assert calls == [full]
    assert source == "full-song" and actual.reverb_gain == complete.reverb_gain


@pytest.mark.parametrize("already_cancelled", [False, True])
def test_pcm_comparison_is_bounded_and_propagates_cancellation(
    tmp_path, monkeypatch, already_cancelled
):
    full, scoped = tmp_path / "full.wav", tmp_path / "scoped.wav"
    for path in (full, scoped):
        sf.write(path, np.zeros((200000, 2)), 44100, subtype="FLOAT")
    calls, _ = _tail_analysis(monkeypatch)
    cancel = threading.Event()
    if already_cancelled:
        cancel.set()
    read = sf.SoundFile.read
    requests = []

    def bounded_read(stream, frames=-1, *args, **kwargs):
        requests.append(frames)
        assert 0 < frames <= 65536
        result = read(stream, frames, *args, **kwargs)
        if len(requests) == 2:
            cancel.set()
        return result

    monkeypatch.setattr(sf.SoundFile, "read", bounded_read)
    with pytest.raises(DomainError) as raised:
        studio_space._reference_tail(SpaceProfile(duration=4), full, scoped, cancel)
    assert raised.value.code == "ProcessCancelled"
    assert requests == ([] if already_cancelled else [65536, 65536])
    assert not calls


def test_supported_scoped_tail_does_not_need_full_file_io(tmp_path, monkeypatch):
    expected = SpaceProfile(reverb_gain=0.2, decay_count=3)
    calls, _ = _tail_analysis(monkeypatch)
    actual, source = studio_space._reference_tail(
        expected, tmp_path / "unused.wav", tmp_path / "scoped.wav", threading.Event()
    )
    assert actual is expected and source == "performed-section"
    assert not calls


def test_pre_dsp_capture_analysis_is_rendering_evidence_not_report_only(tmp_path, monkeypatch):
    reference, recorded, baseline, actual = [
        tmp_path / f"{name}.wav" for name in ("reference", "recorded", "baseline", "actual")
    ]
    samples = np.random.default_rng(91).normal(0, 0.03, 8000 * 4)
    for path in (reference, recorded):
        sf.write(path, samples, 8000, subtype="FLOAT")
    before = recorded.read_bytes()
    expected = SpaceProfile(duration=4, echo_taps=((0.18, 0.2),))
    measured = []

    def measured_acoustics(path, cancel):
        measured.append(path)
        return expected

    monkeypatch.setattr(studio_space, "analyze_space", measured_acoustics)
    wet_report = studio_space.apply_reference_space(
        object(), reference, recorded, recorded, baseline, threading.Event()
    )
    assert measured == [reference, recorded]
    dry_report = studio_space.apply_reference_space(
        object(), reference, recorded, recorded, actual, threading.Event(), recorded_is_dry=True
    )
    # These measurements prevent another return being added to the capture;
    # they cannot be omitted as a report-only optimization.
    assert measured == [reference, recorded, reference, recorded]
    assert dry_report["recorded"]["echo_taps"] == expected.echo_taps
    assert dry_report["recordedAnalysis"] == "measured"
    assert wet_report["recordedAnalysis"] == "measured"
    assert dry_report["applied"] == wet_report["applied"]
    assert not dry_report["applied"]["echo_taps"]
    np.testing.assert_array_equal(sf.read(actual)[0], sf.read(baseline)[0])
    np.testing.assert_array_equal(sf.read(actual)[0], sf.read(recorded)[0])
    assert recorded.read_bytes() == before


def test_wet_capture_still_measures_existing_echo_and_avoids_duplicating_it(tmp_path, monkeypatch):
    reference, recorded, target = [
        tmp_path / f"{name}.wav" for name in ("reference", "recorded", "target")
    ]
    samples = np.random.default_rng(91).normal(0, 0.03, 8000 * 4)
    for path in (reference, recorded):
        sf.write(path, samples, 8000, subtype="FLOAT")
    existing = SpaceProfile(duration=4, echo_taps=((0.18, 0.2),))
    measured = []

    def analyze(path, cancel):
        measured.append(path)
        return existing

    monkeypatch.setattr(studio_space, "analyze_space", analyze)
    report = studio_space.apply_reference_space(
        object(), reference, recorded, recorded, target, threading.Event()
    )
    assert measured == [reference, recorded]
    assert report["recorded"]["echo_taps"] == existing.echo_taps
    assert report["recordedAnalysis"] == "measured"
    assert not report["applied"]["echo_taps"]
    np.testing.assert_array_equal(sf.read(target)[0], sf.read(recorded)[0])


def test_dry_capture_still_honors_analysis_cancellation(tmp_path):
    path = tmp_path / "voice.wav"
    sf.write(path, np.zeros(8000), 8000, subtype="FLOAT")
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(DomainError) as raised:
        studio_space.apply_reference_space(
            object(), path, path, path, tmp_path / "out.wav", cancel, recorded_is_dry=True
        )
    assert raised.value.code == "ProcessCancelled"
