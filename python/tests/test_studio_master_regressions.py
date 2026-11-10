from pathlib import Path
import threading

import numpy as np
import soundfile as sf

from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_delivery import MasterDelivery
from backend.recordings.studio_dynamics import _balance_curve
from backend.recordings.studio_space import apply_reference_space
from backend.recordings.studio_master import FfmpegStudioMasterRenderer
from backend.recordings.studio_reference import reference_section
from backend.recordings.studio_render import MasterRender


def test_unmatched_partial_take_does_not_use_whole_song_balance():
    render = MasterRender.__new__(MasterRender)
    render.gains = np.zeros(100)
    render.voice_db = np.full(100, -30.0)
    render.backing_db = np.full(100, -20.0)
    render.reference_full_db = np.tile([-25.0, -10.0], 200)
    render.original_full_db = np.full(400, -20.0)
    render.processing = {}
    render._fallback_balance()
    np.testing.assert_array_equal(render.gains, 0)


def test_reference_section_excludes_unperformed_song_and_rejects_seeks():
    adjustments = [{"elapsedSeconds": 0, "sourceSeconds": 40, "playbackRate": 1, "keyShift": 0}]
    assert reference_section(adjustments, 10) == (40, 50)
    assert reference_section([], 10) is None
    adjustments.append({"elapsedSeconds": 5, "sourceSeconds": 90, "playbackRate": 1, "keyShift": 0})
    assert reference_section(adjustments, 10) is None


def test_existing_effects_balance_uses_original_vocal_prominence():
    levels = [np.full(100, value, dtype=float) for value in (-30, -30, -12, -18)]
    gains, reliable = _balance_curve(*levels)
    assert reliable.all()
    np.testing.assert_allclose(gains, 6, atol=0.01)


def test_peak_limiter_preserves_timeline_and_tail(tmp_path: Path):
    rate = 8000
    voice = np.zeros(rate)
    voice[50] = 0.2
    voice[-10] = 0.1
    v, b, output = (tmp_path / name for name in ("voice.wav", "backing.wav", "out.wav"))
    sf.write(v, voice, rate, subtype="FLOAT")
    sf.write(b, np.zeros_like(voice), rate, subtype="FLOAT")
    delivery = MasterDelivery(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        b,
        v,
        output,
        threading.Event(),
        sf.info(v),
        1,
        True,
        False,
        None,
        0.2,
        np.ones(10, dtype=bool),
        {},
        None,
    )
    delivery.run()
    actual, _ = sf.read(output)
    np.testing.assert_allclose(actual, voice, atol=2e-6)


def test_stereo_width_alone_does_not_synthesize_reverb(tmp_path: Path):
    rng = np.random.default_rng(77)
    rate = 8000
    dry = rng.normal(0, 0.04, (rate * 8, 1))
    dry = np.repeat(dry, 2, axis=1)
    reference = dry + rng.normal(0, 0.02, dry.shape)
    v, r, output = (tmp_path / name for name in ("voice.wav", "reference.wav", "out.wav"))
    sf.write(v, dry, rate, subtype="FLOAT")
    sf.write(r, reference, rate, subtype="FLOAT")
    report = apply_reference_space(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        r,
        v,
        v,
        output,
        threading.Event(),
    )
    assert report["status"] == "no-supported-addition"
    actual, _ = sf.read(output, always_2d=True)
    np.testing.assert_allclose(actual, dry, atol=1e-8)


def test_reference_balance_is_independent_of_channel_count(tmp_path: Path):
    from backend.recordings.studio_mix_audit import reference_voice_band_distribution

    rate = 8000
    signal = np.sin(2 * np.pi * 700 * np.arange(rate * 8) / rate) * 0.1
    vocal, backing = tmp_path / "mono.wav", tmp_path / "stereo.wav"
    sf.write(vocal, signal, rate, subtype="FLOAT")
    sf.write(backing, np.repeat(signal[:, None], 2, axis=1), rate, subtype="FLOAT")
    result = reference_voice_band_distribution(vocal, backing)
    assert result is not None
    assert abs(result["median"]) < 0.01


def test_calibration_rejects_balance_improvement_that_worsens_delivery():
    from backend.recordings.studio_calibration import distribution_improved

    fields = [
        "voiceBandVocalToBackingP10Db",
        "voiceBandVocalToBackingMedianDb",
        "voiceBandVocalToBackingP90Db",
    ]
    before = dict.fromkeys(fields, -6.0)
    after = dict.fromkeys(fields, -3.0)
    before["outputVsStemSumResidualMedianDb"] = -80.0
    after["outputVsStemSumResidualMedianDb"] = -12.0
    assert not distribution_improved(dict.fromkeys(["p10", "median", "p90"], 0.0), before, after)


def test_studio_separation_does_not_select_kaggle(tmp_path: Path):
    from types import SimpleNamespace
    from unittest.mock import Mock
    from backend.recordings.start_studio_master import StartStudioMaster
    from backend.ai.domain import AiCapability
    from backend.models.domain import ComputeMode

    master = StartStudioMaster.__new__(StartStudioMaster)
    master._settings = lambda: SimpleNamespace(
        selected_separation_provider="kaggle-p100", compute_mode=ComputeMode.CPU, cpu_threads=2
    )
    master._resolver = Mock()
    master._resources = Mock()
    recording = tmp_path / "recording.wav"
    recording.write_bytes(b"source")
    master._separate(SimpleNamespace(file_path=recording), tmp_path, Mock())
    master._resolver.execute.assert_called_once_with(AiCapability.SEPARATION, None)


def test_compression_is_bypassed_without_reference_transitions():
    from backend.recordings.studio_compression import _reference_compression

    recorded = np.tile(np.linspace(-30, -10, 50), 5)
    reference = np.tile(np.linspace(-20, -18, 50), 5)
    assert _reference_compression(recorded, reference)["ratio"] == 1


def test_seek_reference_contains_only_performed_sections(tmp_path: Path):
    from backend.recordings.studio_reference import scope_reference

    path = tmp_path / "reference.wav"
    samples = np.arange(16000, dtype=np.float32) / 16000
    sf.write(path, samples, 8000, subtype="FLOAT")
    adjustments = [
        {"elapsedSeconds": 0, "sourceSeconds": 0, "playbackRate": 1, "keyShift": 0},
        {"elapsedSeconds": 0.25, "sourceSeconds": 1, "playbackRate": 1, "keyShift": 0},
    ]
    vocal, _, _, report = scope_reference(path, path, adjustments, 0.5, tmp_path, threading.Event())
    actual, _ = sf.read(vocal)
    np.testing.assert_array_equal(actual, np.r_[samples[:2000], samples[8000:10000]])
    assert report["referenceTimelineRebuilt"]


def test_existing_effects_duplicate_output_channels_use_stereo(tmp_path: Path):
    source = tmp_path / "voice.wav"
    time = np.arange(8000) / 8000
    channels = np.column_stack(
        [0.1 * np.sin(2 * np.pi * 200 * time), *[0.1 * np.sin(2 * np.pi * 300 * time)] * 5]
    )
    sf.write(source, channels, 8000, subtype="FLOAT")
    render = MasterRender(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        source,
        source,
        source,
        source,
        tmp_path / "out.wav",
        threading.Event(),
        source,
        True,
        False,
        False,
        (),
        None,
    )
    render.info, render.work = sf.info(source), tmp_path
    render._prepare_stems()
    assert render.output_channels == 2
    assert sf.info(source).channels == 6
