"""A pre-DSP capture can already contain an acoustic room or reflection."""

import threading

import numpy as np
import pytest
from scipy.signal import fftconvolve
import soundfile as sf

from backend.domain_errors import DomainError
from backend.recordings import studio_space


def _signals(rate, effect):
    time = np.arange(rate * 12) / rate
    dry = np.random.default_rng(42).normal(0, 0.04, len(time))
    if effect == "room":
        dry *= np.remainder(time, 3) < 1
        tail_time = np.arange(round(0.9 * rate)) / rate
        impulse = np.random.default_rng(7).normal(size=len(tail_time))
        impulse *= np.exp(-6.9078 * tail_time / 0.9)
        impulse /= np.linalg.norm(impulse)
        wet = dry + 0.3 * fftconvolve(dry, impulse)[: len(dry)]
    else:
        wet = dry.copy()
        shift = round(0.2 * rate)
        wet[shift:] += 0.25 * dry[:-shift]
    return [np.repeat(samples[:, None], 2, axis=1) for samples in (dry, wet)]


def _inputs(tmp_path, rate, effect, existing):
    dry, wet = _signals(rate, effect)
    reference, recorded = [tmp_path / f"{name}.wav" for name in ("reference", "recorded")]
    sf.write(reference, wet, rate, subtype="FLOAT")
    sf.write(recorded, wet if existing else dry, rate, subtype="FLOAT")
    return reference, recorded


def _render(tmp_path, rate, reference, recorded, marker):
    target = tmp_path / f"render-{marker}.wav"
    report = studio_space.apply_reference_space(
        object(), reference, recorded, recorded, target, threading.Event(), recorded_is_dry=marker
    )
    output, actual_rate = sf.read(target, always_2d=True)
    assert actual_rate == rate
    assert output.shape == (rate * 12, 2)
    assert np.isfinite(output).all()
    return output, report


@pytest.mark.parametrize("rate", [44100, 48000])
@pytest.mark.parametrize("effect", ["room", "reflection"])
def test_pre_dsp_marker_does_not_duplicate_measured_capture_acoustics(tmp_path, rate, effect):
    reference, recorded = _inputs(tmp_path, rate, effect, existing=True)
    originals = [path.read_bytes() for path in (reference, recorded)]
    direct = sf.read(recorded, always_2d=True)[0]
    wet, wet_report = _render(tmp_path, rate, reference, recorded, False)
    dry, dry_report = _render(tmp_path, rate, reference, recorded, True)

    np.testing.assert_array_equal(wet, direct)
    # The exact same acoustic PCM must not acquire another room or echo merely
    # because the capture precedes software effects.
    np.testing.assert_array_equal(dry, direct)
    for report in (wet_report, dry_report):
        assert report["recordedAnalysis"] == "measured"
        assert not report["wetBalance"]["buses"]
        if effect == "room":
            assert report["recorded"]["decay_count"] >= 3
            assert report["recorded"]["reverb_gain"] > 0.05
        else:
            assert report["recorded"]["echo_taps"][0][0] == pytest.approx(0.2, abs=0.001)
            assert report["recorded"]["echo_taps"][0][1] > 0.15
    assert dry_report["existingEffectsPolicy"] == "dry-capture-acoustics"
    assert wet_report["existingEffectsPolicy"] == "estimated-wet-stem"
    assert [path.read_bytes() for path in (reference, recorded)] == originals


@pytest.mark.parametrize("rate", [44100, 48000])
@pytest.mark.parametrize("effect", ["room", "reflection"])
def test_genuinely_dry_capture_still_receives_the_supported_reference_effect(
    tmp_path, rate, effect
):
    reference, recorded = _inputs(tmp_path, rate, effect, existing=False)
    originals = [path.read_bytes() for path in (reference, recorded)]
    direct = sf.read(recorded, always_2d=True)[0]
    wet, wet_report = _render(tmp_path, rate, reference, recorded, False)
    dry, dry_report = _render(tmp_path, rate, reference, recorded, True)

    np.testing.assert_array_equal(dry, wet)
    assert np.mean((dry - direct) ** 2) > 1e-6
    assert dry_report["applied"] == wet_report["applied"]
    assert dry_report["wetBalance"]["buses"]
    assert [path.read_bytes() for path in (reference, recorded)] == originals


@pytest.mark.parametrize("rate", [44100, 48000])
def test_pre_dsp_capture_analysis_is_bounded_and_cancellable(tmp_path, monkeypatch, rate):
    reference, recorded = _inputs(tmp_path, rate, "room", existing=True)
    originals = [path.read_bytes() for path in (reference, recorded)]
    target = tmp_path / "cancelled.wav"
    cancel = threading.Event()
    analyze, read = studio_space.analyze_space, sf.SoundFile.read
    in_capture = False
    requests = []

    def measure(path, event):
        nonlocal in_capture
        in_capture = path == recorded
        try:
            return analyze(path, event)
        finally:
            in_capture = False

    def bounded_read(stream, frames=-1, *args, **kwargs):
        if in_capture:
            assert 0 < frames <= rate * 2
            requests.append(frames)
        samples = read(stream, frames, *args, **kwargs)
        if in_capture:
            cancel.set()
        return samples

    monkeypatch.setattr(studio_space, "analyze_space", measure)
    monkeypatch.setattr(sf.SoundFile, "read", bounded_read)
    with pytest.raises(DomainError) as raised:
        studio_space.apply_reference_space(
            object(), reference, recorded, recorded, target, cancel, recorded_is_dry=True
        )
    assert raised.value.code == "ProcessCancelled"
    assert requests == [rate * 2]
    assert not target.exists()
    assert [path.read_bytes() for path in (reference, recorded)] == originals
