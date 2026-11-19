"""Finishing a calibrated voice must not add a second placement envelope."""

import threading

import numpy as np
import pytest
import soundfile as sf

from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_audio import _profile
from backend.recordings.studio_calibration import GainPlan
from backend.recordings.studio_master import FfmpegStudioMasterRenderer
from backend.recordings.studio_render import MasterRender
from backend.recordings.studio_voice import integrate_voice


def test_master_finishing_preserves_a_successful_steady_vocal_gain_plan(tmp_path):
    rate = 16000
    time = np.arange(rate * 12) / rate
    voice = 0.05 * np.sin(2 * np.pi * 700 * time)
    backing = 0.05 * np.sin(2 * np.pi * 1100 * time)
    backing[time >= 6] *= 0.25
    source, music = tmp_path / "voice.wav", tmp_path / "music.wav"
    sf.write(source, voice, rate, subtype="FLOAT")
    sf.write(music, backing, rate, subtype="FLOAT")
    originals = source.read_bytes(), music.read_bytes()
    render = MasterRender.__new__(MasterRender)
    render.renderer = FfmpegStudioMasterRenderer(ProcessRunner())
    render.work, render.cancel = tmp_path, threading.Event()
    render.vocal = render.user_vocal = render.reference_vocal = render.space_reference = source
    render.backing = music
    render.info, render.output_channels = sf.info(source), 1
    render.processing, render.process_voice, render.pitch = {}, True, None
    render.timing_known = True
    render.spectral = {"bands": [], "overlap": 0.0, "ratioDb": []}
    level = _profile(source, render.cancel, frame_seconds=0.02)
    render.times = render.source_times = (np.arange(len(level)) + 0.5) * 0.02
    render.plan = GainPlan(
        render.times,
        np.zeros(len(level)),
        np.ones(len(level), dtype=bool),
        level,
        np.zeros(len(level)),
        {"method": "single-context-envelope"},
    )

    render._write_balanced()
    calibrated, _ = sf.read(render.balanced)
    assert render.processing["mixConstraints"]["p90ErrorDb"] < 0.001
    np.testing.assert_array_equal(calibrated, sf.read(source)[0])

    render._finish_voice()
    finished, finished_rate = sf.read(render.balanced)

    assert finished_rate == rate and finished.shape == calibrated.shape
    gains = []
    for start, end in [(2, 4), (8, 10)]:
        section = (time >= start) & (time < end)
        gains.append(
            10 * np.log10(np.mean(finished[section] ** 2) / np.mean(calibrated[section] ** 2))
        )
    # The input and reference voice stay steady while only the accompaniment
    # changes. A second automatic controller must not undo the approved plan.
    assert np.ptp(gains) < 0.1, gains
    assert (source.read_bytes(), music.read_bytes()) == originals


def test_standalone_integration_retains_its_default_placement_control(tmp_path):
    rate = 16000
    time = np.arange(rate * 4) / rate
    voice, backing = tmp_path / "voice.wav", tmp_path / "backing.wav"
    samples = 0.05 * np.sin(2 * np.pi * 700 * time)
    sf.write(voice, samples, rate, subtype="FLOAT")
    sf.write(backing, 0.005 * np.sin(2 * np.pi * 1100 * time), rate, subtype="FLOAT")

    result, _ = integrate_voice(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        voice,
        backing,
        voice,
        tmp_path / "out.wav",
        threading.Event(),
        reference_timing=None,
    )

    actual, _ = sf.read(result)
    change = 10 * np.log10(np.mean(actual**2) / np.mean(samples**2))
    assert change == pytest.approx(-2.5, abs=0.01)


def test_calibrated_integration_keeps_reference_body_tone_processing(tmp_path):
    rate = 16000
    time = np.arange(rate * 5) / rate
    source, reference, backing = (tmp_path / name for name in ("voice.wav", "ref.wav", "music.wav"))
    middle = 0.035 * np.sin(2 * np.pi * 1000 * time)
    sf.write(source, 0.2 * np.sin(2 * np.pi * 350 * time) + middle, rate, subtype="FLOAT")
    sf.write(reference, 0.03 * np.sin(2 * np.pi * 350 * time) + middle, rate, subtype="FLOAT")
    sf.write(backing, 0.04 * np.sin(2 * np.pi * 1700 * time), rate, subtype="FLOAT")
    axis = (np.arange(50) + 0.5) * 0.1
    cancel = threading.Event()

    result, report = integrate_voice(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        source,
        backing,
        reference,
        tmp_path / "out.wav",
        cancel,
        reference_timing=(axis, axis),
        placement_calibrated=True,
    )

    levels = [
        _profile(path, cancel, voice_band=True, band_hz=band)
        for path in (source, result)
        for band in ((150, 600), (600, 3500))
    ]
    assert np.median(levels[2] - levels[3] - levels[0] + levels[1]) < -3
    assert max(report["placementTrimDb"]) == 0
    assert sf.info(result).frames == sf.info(source).frames


@pytest.mark.parametrize("calibrated", [False, True])
def test_finishing_cancellation_is_honored_after_tone_analysis(tmp_path, monkeypatch, calibrated):
    from backend.domain_errors import DomainError
    from backend.recordings import studio_voice

    source = tmp_path / "voice.wav"
    sf.write(source, 0.05 * np.sin(2 * np.pi * 700 * np.arange(32000) / 16000), 16000)
    original = source.read_bytes()
    cancel = threading.Event()
    analyze = studio_voice._body_correction

    def cancel_after_analysis(*args):
        result = analyze(*args)
        cancel.set()
        return result

    monkeypatch.setattr(studio_voice, "_body_correction", cancel_after_analysis)
    with pytest.raises(DomainError, match="cancel"):
        integrate_voice(
            FfmpegStudioMasterRenderer(ProcessRunner()),
            source,
            source,
            source,
            tmp_path / "out.wav",
            cancel,
            reference_timing=None,
            placement_calibrated=calibrated,
        )
    assert source.read_bytes() == original
