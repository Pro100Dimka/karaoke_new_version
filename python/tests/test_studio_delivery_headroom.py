"""Hot but unclipped stems must not make the whole master pump with each peak."""

import threading

import numpy as np
import pytest
import soundfile as sf

from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_delivery import MasterDelivery
from backend.recordings.studio_master import FfmpegStudioMasterRenderer


@pytest.mark.parametrize("rate", [44100, 48000])
@pytest.mark.parametrize("channels", [1, 2])
def test_hot_sum_preserves_dynamics_with_one_constant_headroom_gain(tmp_path, rate, channels):
    time = np.arange(rate * 4) / rate
    vocal = 0.55 * np.sin(2 * np.pi * 700 * time)
    # A dense chorus alternating with softer accompaniment exposes limiter recovery.
    envelope = np.where((time % 1) < 0.4, 0.75, 0.15)
    backing = envelope * np.sin(2 * np.pi * 1100 * time)
    if channels == 2:
        vocal = np.column_stack((vocal, vocal))
        backing = np.column_stack((backing, -backing))
    voice_path, backing_path, target = (
        tmp_path / name for name in ("voice.wav", "music.wav", "master.wav")
    )
    sf.write(voice_path, vocal, rate, subtype="FLOAT")
    sf.write(backing_path, backing, rate, subtype="FLOAT")
    original = [path.read_bytes() for path in (voice_path, backing_path)]
    processing = {}
    MasterDelivery(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        backing_path,
        voice_path,
        target,
        threading.Event(),
        sf.info(voice_path),
        channels,
        True,
        False,
        None,
        0,
        np.ones(40, dtype=bool),
        processing,
        None,
    ).run()

    actual, actual_rate = sf.read(target)
    delivery = processing["delivery"]
    assert actual_rate == rate and actual.shape == vocal.shape
    assert delivery["truePeakDbtp"] <= -1
    # Attenuate the entire mix once instead of repeatedly reducing every loud syllable.
    assert delivery["globalGainDb"] < -2
    expected = (vocal + backing) * 10 ** (delivery["globalGainDb"] / 20)
    np.testing.assert_allclose(actual, expected, atol=2e-6)
    assert [path.read_bytes() for path in (voice_path, backing_path)] == original
