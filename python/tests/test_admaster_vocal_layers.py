"""The full master must contain the requested own-voice return, not only its report."""

import threading

import numpy as np
import pytest
import soundfile as sf

from backend.ai.domain import PitchPoint
from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings import studio_layers
from backend.recordings.studio_master import FfmpegStudioMasterRenderer
from backend.recordings.studio_layer_types import VocalLayerRegion


def _inputs(root, rate):
    time = np.arange(rate * 6) / rate
    # A single known partial makes output-frequency proof independent of formant shaping.
    voice = 0.05 * np.sin(2 * np.pi * 240 * time)
    music = 0.025 * np.sin(2 * np.pi * 83 * time) + 0.01 * np.sin(2 * np.pi * 930 * time)
    paths = [root / f"{name}.wav" for name in ("voice", "music", "reference", "project", "mix")]
    for path, samples in zip(paths, [voice, music, voice, music, voice + music]):
        sf.write(path, np.column_stack([samples, samples * 0.95]), rate, subtype="FLOAT")
    return paths


def _render(paths, target):
    # Exact synthetic pitch keeps melodic correction inactive in this wiring test.
    points = [PitchPoint(index * 0.02, 240, 0.99, True) for index in range(300)]
    return FfmpegStudioMasterRenderer(ProcessRunner()).render(
        *paths[:4],
        target,
        threading.Event(),
        performance_mix=paths[4],
        exact_stems=True,
        process_voice=True,
        pitch=lambda _: points,
        adjustments=[dict(elapsedSeconds=0, sourceSeconds=0, playbackRate=1, keyShift=0)],
    )


def _normalized_audio(path, report):
    samples, rate = sf.read(path, always_2d=True)
    gain = 10 ** (report.processing["delivery"]["globalGainDb"] / 20)
    return samples / gain, rate


@pytest.mark.parametrize("rate", [44100, 48000])
def test_final_master_uses_layer_return_after_calibration(tmp_path, rate, monkeypatch):
    paths = _inputs(tmp_path, rate)
    target, control = tmp_path / "master.wav", tmp_path / "control.wav"
    monkeypatch.setattr(
        studio_layers,
        "analyze_reference_layers",
        lambda *_: ([VocalLayerRegion(2, 4, "octave", 0.25, semitones=-12)], {}),
    )
    report = _render(paths, target)
    monkeypatch.setattr(studio_layers, "analyze_reference_layers", lambda *_: ([], {}))
    baseline = _render(paths, control)
    samples, output_rate = _normalized_audio(target, report)
    before, _ = _normalized_audio(control, baseline)
    wet = (samples - before).mean(1)
    middle = wet[round(2.4 * rate) : round(3.6 * rate)]
    spectrum = abs(np.fft.rfft(middle * np.hanning(len(middle)))) ** 2
    frequencies = np.fft.rfftfreq(len(middle), 1 / rate)
    assert np.sum(spectrum[abs(frequencies - 120) < 3]) > np.sum(spectrum) * 0.5
    assert np.sqrt(np.mean(middle**2)) > 0.001
    assert np.max(abs(wet[: round(1.8 * rate)])) < 1e-5
    assert samples.shape == (rate * 6, 2) and output_rate == rate
    assert report.processing["vocalLayers"]["applied"] is True
    assert report.processing["gainApplications"] == 1
    assert report.processing["delivery"]["truePeakDbtp"] <= -1
