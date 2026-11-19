"""Exercise vocal balance and final headroom through the complete ADMaster render."""

import threading

import numpy as np
import pytest
import soundfile as sf

from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_master import FfmpegStudioMasterRenderer


def test_master_keeps_a_steady_singer_stable_through_a_quiet_backing_section(tmp_path):
    rate = 48000
    time = np.arange(rate * 30) / rate
    voice = 0.05 * np.sin(2 * np.pi * 700 * time)
    music = 0.05 * np.sin(2 * np.pi * 900 * time)
    music[(time >= 10) & (time < 20)] *= 0.015
    paths = {name: tmp_path / f"{name}.wav" for name in ("voice", "music", "reference", "mix")}
    for name, samples in {
        "voice": voice,
        "music": music,
        "reference": voice,
        "mix": voice + music,
    }.items():
        sf.write(paths[name], samples, rate, subtype="FLOAT")
    before = {name: path.read_bytes() for name, path in paths.items()}
    target = tmp_path / "master.wav"

    result = FfmpegStudioMasterRenderer(ProcessRunner()).render(
        paths["voice"],
        paths["music"],
        paths["reference"],
        paths["music"],
        target,
        threading.Event(),
        performance_mix=paths["mix"],
        exact_stems=True,
        process_voice=True,
        adjustments=[{"elapsedSeconds": 0, "sourceSeconds": 0, "playbackRate": 1, "keyShift": 0}],
    )

    actual, actual_rate = sf.read(target)
    delivery = result.processing["delivery"]
    assert actual_rate == rate and actual.shape == voice.shape
    assert delivery["truePeakDbtp"] <= -1
    # Delivery's single constant gain lets us inspect the audible voice in the final mix.
    mastered_voice = actual / 10 ** (delivery["globalGainDb"] / 20) - music
    body = (time >= 3) & (time < 7)
    quiet = (time >= 13) & (time < 17)
    steady_power = np.mean(mastered_voice[body] ** 2)
    assert abs(10 * np.log10(np.mean(mastered_voice[quiet] ** 2) / steady_power)) < 3
    middle = mastered_voice[(time >= 3) & (time < 27)]
    assert np.max(np.abs(middle)) < np.sqrt(2 * steady_power) * 10 ** (3 / 20)
    assert result.processing["gainApplications"] == 1
    assert {name: path.read_bytes() for name, path in paths.items()} == before


@pytest.mark.parametrize("source_format", ["wav", "flac"])
def test_short_take_preserves_the_performance_when_vocal_evidence_is_insufficient(
    tmp_path, source_format
):
    rate = 48000
    time = np.arange(rate * 2) / rate
    dry = 0.04 * np.sin(2 * np.pi * 440 * time) * (time < 0.3)
    echo = 0.024 * np.sin(2 * np.pi * 440 * time) * ((time >= 0.65) & (time < 0.95))
    music = 0.02 * np.sin(2 * np.pi * 220 * time)
    voice, backing, reference, project = (
        tmp_path / f"{name}.wav" for name in ("voice", "backing", "reference", "project")
    )
    for path, samples in zip((voice, backing, reference, project), (dry, music, dry, music * 5)):
        sf.write(path, samples, rate, subtype="FLOAT")
    performance = tmp_path / f"performance.{source_format}"
    sf.write(performance, dry + echo + music, rate, subtype="PCM_24")
    before = performance.read_bytes()
    expected, _ = sf.read(performance)
    target = tmp_path / "master.wav"

    result = FfmpegStudioMasterRenderer(ProcessRunner()).render(
        voice,
        backing,
        reference,
        project,
        target,
        threading.Event(),
        performance_mix=performance,
        exact_stems=True,
        process_voice=True,
    )

    actual, actual_rate = sf.read(target)
    assert actual_rate == rate and actual.shape == expected.shape
    np.testing.assert_allclose(actual, expected, atol=1e-7)
    assert sf.info(target).format == "WAV"
    assert result.processing["bypassReason"] == "insufficient-vocal-evidence"
    assert performance.read_bytes() == before
