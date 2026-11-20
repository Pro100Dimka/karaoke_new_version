"""Meter the actual float32 glue output in its render without changing delivery."""

from pathlib import Path
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_adaptive_delivery import (
    _glue,
    _render_glue,
    deliver_master,
    measure_loudness,
)
from backend.recordings.studio_master import FfmpegStudioMasterRenderer


class RecordingRunner(ProcessRunner):
    def __init__(self):
        self.commands = []

    def run(self, command, **kwargs):
        self.commands.append(command)
        return super().run(command, **kwargs)


def _dynamic(rate, seconds=4.0):
    time = np.arange(round(rate * seconds)) / rate
    gain = np.array([0.4, 0.025, 0.12, 0.025, 0.25, 0.035, 0.16, 0.025])
    envelope = gain[np.minimum((time * 2).astype(int), len(gain) - 1)]
    mono = envelope * (np.sin(2 * np.pi * 731 * time) + 0.2 * np.sin(2 * np.pi * 1297 * time))
    return np.column_stack([mono, -0.7 * mono])


def test_delivery_does_not_launch_a_second_process_to_meter_glue(tmp_path):
    source, target = tmp_path / "source.wav", tmp_path / "master.wav"
    sf.write(source, _dynamic(8000), 8000, subtype="FLOAT")
    runner = RecordingRunner()
    report = deliver_master(FfmpegStudioMasterRenderer(runner), source, target, threading.Event())
    assert report["glueCompression"]["applied"] is True
    separate = [
        command
        for command in runner.commands
        if "-i" in command
        and Path(command[command.index("-i") + 1]).name == "glue.wav"
        and command[command.index("-filter_complex") + 1].startswith("[0:a]ebur128=")
    ]
    assert separate == [], "Glue is read by a redundant second FFmpeg meter process"
    final_meters = [
        command
        for command in runner.commands
        if "-i" in command
        and Path(command[command.index("-i") + 1]).name in ("candidate.wav", "corrected.wav")
        and command[command.index("-filter_complex") + 1].startswith("[0:a]ebur128=")
    ]
    encoded_meters = [
        command
        for command in runner.commands
        if "[dec:0]ebur128=peak=true:framelog=verbose[meter]" in command and "pcm_s24le" in command
    ]
    assert (final_meters or encoded_meters) and sf.info(target).subtype == "PCM_24"


@pytest.mark.parametrize("rate", [8000, 44100, 48000])
@pytest.mark.parametrize("kind", ["noise", "peaks", "short", "silence"])
def test_fused_glue_matches_encoded_float_samples_and_all_meter_fields(tmp_path, rate, kind):
    source, baseline, fused = (
        tmp_path / name for name in ("input.wav", "baseline.wav", "fused.wav")
    )
    samples = _dynamic(rate, 0.2 if kind == "short" else 4.0)
    if kind == "noise":
        samples += np.random.default_rng(71).normal(0, 0.025, samples.shape)
    if kind == "peaks":
        samples[:: rate // 4, 0] = 1.17
        samples[rate // 8 :: rate // 4, 1] = -0.95
    if kind == "silence":
        samples[:] = 0
    sf.write(source, samples, rate, subtype="FLOAT")
    renderer, cancel = FfmpegStudioMasterRenderer(ProcessRunner()), threading.Event()
    threshold = -26.020599913279625
    renderer._mix(
        source,
        source,
        f"[0:a]acompressor=threshold={10 ** (threshold / 20):.9f}:ratio=2:"
        "attack=30:release=200:knee=2:makeup=1:mix=0.2:link=maximum:detection=rms[out]",
        ["-c:a", "pcm_f32le", str(baseline)],
        cancel,
    )
    expected = measure_loudness(renderer, baseline, cancel)
    actual = _render_glue(renderer, source, fused, threshold, cancel)
    before, original_rate = sf.read(baseline, dtype="float32", always_2d=True)
    after, actual_rate = sf.read(fused, dtype="float32", always_2d=True)
    np.testing.assert_array_equal(after, before)
    assert actual == expected and original_rate == actual_rate == rate
    assert sf.info(fused).subtype == "FLOAT"
    if kind == "peaks":
        assert np.max(np.abs(after)) > 1, "The float32 boundary must not saturate floating PCM"


@pytest.mark.parametrize("kind", ["short", "steady"])
def test_bypassed_glue_keeps_source_and_does_not_invent_measurement(tmp_path, kind):
    rate = 8000
    time = np.arange(round(rate * (0.2 if kind == "short" else 2))) / rate
    source, target = tmp_path / "input.wav", tmp_path / "glue.wav"
    sf.write(source, 0.2 * np.sin(2 * np.pi * 220 * time), rate, subtype="FLOAT")
    runner, cancel = RecordingRunner(), threading.Event()
    actual, compression, measured = _glue(
        FfmpegStudioMasterRenderer(runner), source, target, cancel
    )
    assert actual == source and compression["applied"] is False and measured is None
    assert not runner.commands and not target.exists()
