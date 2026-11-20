"""Meter the actual encoded PCM packets while the final limiter is rendering."""

import threading

import numpy as np
import pytest
import soundfile as sf

from backend.recordings.studio_adaptive_delivery import (
    DeliveryPlan,
    _encode_limited,
    measure_loudness,
)
from backend.recordings.studio_master import FfmpegStudioMasterRenderer
from tests.test_studio_delivery_fusion import RecordingRunner, _dynamic
from backend.infrastructure.process_runner import ProcessResult


@pytest.mark.parametrize(
    "rate,channels,kind",
    [
        (8000, 1, "short"),
        (44100, 2, "peaks"),
        (48000, 6, "noise"),
        (44100, 2, "silence"),
        (96000, 2, "tone"),
    ],
)
def test_limiter_measures_its_encoded_pcm_in_the_same_process(tmp_path, rate, channels, kind):
    source, baseline, actual = (
        tmp_path / name for name in ("source.wav", "baseline.wav", "actual.wav")
    )
    samples = _dynamic(rate, 0.23 if kind == "short" else 4.137)[:, :1]
    samples = np.repeat(samples, channels, axis=1)
    if kind == "peaks":
        samples[::37] *= 8
    if kind == "silence":
        samples[:] = 0
    if kind == "noise":
        samples += np.random.default_rng(132).normal(0, 0.2, samples.shape)
    sf.write(source, samples, rate, subtype="FLOAT")
    runner, cancel = RecordingRunner(), threading.Event()
    renderer, info = FfmpegStudioMasterRenderer(runner), sf.info(source)
    plan = DeliveryPlan(-12, -12, -16, -4, 3.5, 3, max(rate, min(192000, rate * 4)))
    graph = (
        f"[0:a]aresample={plan.oversampled},volume={plan.gain:.9f}dB,"
        "alimiter=limit=0.860993753:attack=5:release=80:level=0:latency=1,"
        f"aresample={rate},apad,atrim=end_sample={info.frames}[out]"
    )
    renderer._mix(
        source,
        source,
        graph,
        ["-ar", str(rate), "-ac", str(channels), "-c:a", "pcm_s24le", str(baseline)],
        cancel,
    )
    expected = measure_loudness(renderer, baseline, cancel)
    measured = _encode_limited(renderer, source, actual, plan, info, cancel)
    assert measured == expected, "Limiter output requires a redundant second decoder pass"
    before, sr = sf.read(baseline, dtype="int32", always_2d=True)
    after, actual_sr = sf.read(actual, dtype="int32", always_2d=True)
    np.testing.assert_array_equal(after, before)
    assert sr == actual_sr == rate and sf.info(actual).subtype == "PCM_24"
    encoded = [command for command in runner.commands if str(actual) in command]
    assert len(encoded) == 1 and "-dec" in encoded[0]
    assert "[dec:0]ebur128=peak=true:framelog=verbose[meter]" in encoded[0]


def test_unsupported_loopback_uses_the_existing_separate_meter_path(tmp_path):
    class LegacyRunner(RecordingRunner):
        def run(self, command, **kwargs):
            if "-version" in command:
                self.commands.append(command)
                return ProcessResult(1, b"", b"Unrecognized option 'dec'.")
            return super().run(command, **kwargs)

    source = tmp_path / "source.wav"
    sf.write(source, _dynamic(8000), 8000, subtype="FLOAT")
    runner, cancel = LegacyRunner(), threading.Event()
    renderer, info = FfmpegStudioMasterRenderer(runner), sf.info(source)
    plan = DeliveryPlan(-12, -12, -16, -4, 3.5, 3, 32000)
    for index in range(2):
        target = tmp_path / f"candidate-{index}.wav"
        assert _encode_limited(renderer, source, target, plan, info, cancel) is None
        assert measure_loudness(renderer, target, cancel)["integratedLufs"] is not None
    probes = [command for command in runner.commands if "-version" in command]
    assert len(probes) == 1 and probes[0][-3:] == ["-dec", "0:0", "-version"]
    assert all("-dec" not in command for command in runner.commands if "-version" not in command)
