"""The first master measures its sum without rendering unused dynamic normalization."""

import json
import re
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.infrastructure.ffmpeg_audio import loudnorm_filter, parse_loudness
from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_delivery import MasterDelivery
from backend.recordings.studio_master import FfmpegStudioMasterRenderer
from backend.recordings.studio_meter import measure_master_input_levels


class _ObservedRunner(ProcessRunner):
    def __init__(self):
        self.results = []

    def run(self, command, **kwargs):
        result = super().run(command, **kwargs)
        self.results.append(result)
        return result


@pytest.mark.parametrize("rate,channels", [(8000, 1), (44100, 2), (48000, 2)])
@pytest.mark.parametrize("voice_gain", [0.0, 6.0])
def test_first_delivery_meters_the_actual_sum_with_unity_analysis_output(
    tmp_path, rate, channels, voice_gain
):
    time = np.arange(round(rate * 3.043)) / rate
    voice = 0.04 * np.sin(2 * np.pi * (rate / 4) * time + np.pi / 4)
    music = 0.03 * np.sin(2 * np.pi * 700 * time) * (0.25 + time / time[-1])
    if channels == 2:
        voice = np.column_stack((voice, -voice))
        music = np.column_stack((music, music))
    voice[-1] = 0.3  # The last resampled peak must participate in headroom planning.
    vocal, backing, target = [tmp_path / f"{name}.wav" for name in ("voice", "music", "master")]
    sf.write(vocal, voice, rate, subtype="FLOAT")
    sf.write(backing, music, rate, subtype="FLOAT")
    originals = [path.read_bytes() for path in (vocal, backing)]
    runner, processing = _ObservedRunner(), {}
    MasterDelivery(
        FfmpegStudioMasterRenderer(runner),
        backing,
        vocal,
        target,
        threading.Event(),
        sf.info(vocal),
        channels,
        True,
        False,
        None,
        0,
        np.ones(31, dtype=bool),
        processing,
        None,
        voice_gain_db=voice_gain,
    ).run()

    first = re.search(rb'\{\s*"input_i".*?\}', runner.results[0].stderr, re.S)
    assert first is not None
    measured = json.loads(first.group())
    assert measured["normalization_type"] == "linear"
    assert measured["input_i"] == measured["output_i"]
    assert measured["input_lra"] == measured["output_lra"]
    assert b"Peak level dB:" in runner.results[0].stderr
    actual, actual_rate = sf.read(target)
    gain = 10 ** (processing["delivery"]["globalGainDb"] / 20)
    expected = (music + voice * 10 ** (voice_gain / 20)) * gain
    np.testing.assert_allclose(actual, expected, atol=2e-6, rtol=0)
    assert actual_rate == rate and actual.shape == voice.shape
    assert processing["delivery"]["truePeakDbtp"] <= -1
    assert originals == [path.read_bytes() for path in (vocal, backing)]


@pytest.mark.parametrize("rate", [44100, 48000])
def test_input_loudness_agrees_with_the_original_meter_across_quiet_phrases(tmp_path, rate):
    time = np.arange(round(rate * 12.043)) / rate
    envelope = np.where(time % 3 < 1.5, 0.08, 0.0002)
    voice = envelope * np.sin(2 * np.pi * 220 * time)
    music = 0.02 * np.sin(2 * np.pi * 913 * time) * (0.2 + 0.8 * (time > 4))
    voice[-1] = 0.6
    vocal, backing = [tmp_path / f"{name}.wav" for name in ("voice", "music")]
    sf.write(vocal, np.column_stack((voice, -voice)), rate, subtype="FLOAT")
    sf.write(backing, np.column_stack((music, music)), rate, subtype="FLOAT")
    renderer, cancel = FfmpegStudioMasterRenderer(ProcessRunner()), threading.Event()
    chain = "[1:a]volume=3dB[v];[0:a][v]amix=inputs=2:duration=first:normalize=0,"
    legacy = renderer._mix(
        backing,
        vocal,
        chain + loudnorm_filter(lra=11) + "[out]",
        ["-f", "null", "-"],
        cancel,
        quiet=False,
    )
    expected = parse_loudness(legacy.stderr)
    actual = measure_master_input_levels(renderer, backing, vocal, chain, cancel)
    assert actual is not None and expected is not None
    assert actual["input_i"] == pytest.approx(expected["input_i"], abs=0.1)
    assert actual["input_lra"] == pytest.approx(expected["input_lra"], abs=0.2)
    assert actual["input_tp"] == pytest.approx(expected["input_tp"], abs=0.02)
