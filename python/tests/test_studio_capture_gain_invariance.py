"""Recording gain must not decide the delivered voice-to-music balance."""

from pathlib import Path
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_adaptive_balance import plan_balance
from backend.recordings.studio_adaptive_delivery import deliver_master
from backend.recordings.studio_master import FfmpegStudioMasterRenderer


def _write(root: Path, name: str, samples: np.ndarray, rate: int = 16000) -> Path:
    path = root / f"{name}.wav"
    sf.write(path, samples, rate, subtype="FLOAT")
    return path


@pytest.mark.parametrize("music_gain,microphone_gain", [(0.1, 1), (1, 1), (1, 0.2)])
def test_supported_voice_calibration_survives_different_capture_levels(
    tmp_path, music_gain, microphone_gain
):
    time = np.arange(16000 * 8) / 16000
    singing = ((time > 0.5) & (time < 3.5)) | ((time > 4.5) & (time < 7.5))
    voice = 0.03 * np.sin(2 * np.pi * 900 * time) * singing
    noise = np.random.default_rng(81).normal(0, 0.001, len(time))
    music = 0.2 * np.sin(2 * np.pi * 160 * time)
    actual = _write(tmp_path, "voice", (voice + noise) * microphone_gain)
    backing = _write(tmp_path, "music", music * music_gain)
    reference = _write(tmp_path, "reference", voice * 10)
    original = _write(tmp_path, "original", music)
    plan = plan_balance(actual, backing, reference, original, threading.Event())
    expected = 20 * np.log10(10 * music_gain / microphone_gain)
    assert plan.report["referenceUsed"]
    np.testing.assert_allclose(plan.gains[plan.matched], expected, atol=0.3)
    assert plan.report["limitedFraction"] < 0.02


def test_continuous_noisy_periodicity_is_not_clean_capture_evidence(tmp_path):
    time = np.arange(16000 * 8) / 16000
    carrier = 0.03 * np.sin(2 * np.pi * 900 * time)
    noise = np.random.default_rng(9).normal(0, 0.008, len(time))
    actual = _write(tmp_path, "voice", carrier + noise)
    backing = _write(tmp_path, "music", 0.2 * np.sin(2 * np.pi * 160 * time))
    reference = _write(tmp_path, "reference", carrier * 10)
    plan = plan_balance(actual, backing, reference, backing, threading.Event())
    assert plan.report["referenceUsed"]
    assert np.max(plan.gains) <= 9
    assert plan.report["calibrationEvidence"]["method"] == "insufficient-noise-evidence"


@pytest.mark.parametrize("peak", [False, True])
def test_master_delivery_is_invariant_to_common_stem_attenuation(tmp_path, peak):
    time = np.arange(16000 * 4) / 16000
    samples = 0.06 * np.sin(2 * np.pi * 700 * time)
    samples += 0.08 * np.sin(2 * np.pi * 1100 * time)
    if peak:
        samples[16000] = 0.8
    reference = _write(tmp_path, "reference", samples * 1.5)
    renderer = FfmpegStudioMasterRenderer(ProcessRunner())
    outputs, reports = [], []
    for gain in (1.0, 0.01):
        source = _write(tmp_path, f"input-{gain}", samples * gain)
        target = tmp_path / f"master-{gain}.wav"
        reports.append(
            deliver_master(renderer, source, target, threading.Event(), reference=reference)
        )
        outputs.append(sf.read(target)[0])
    assert reports[1]["integratedLufs"] == pytest.approx(reports[0]["integratedLufs"], abs=0.2)
    assert reports[1]["globalGainDb"] - reports[0]["globalGainDb"] == pytest.approx(40, abs=0.2)
    assert all(report["truePeakDbtp"] <= -1 for report in reports)
    assert all(report["plannedLimiterReductionDb"] <= 2.001 for report in reports)
    assert np.corrcoef(*outputs)[0, 1] > 0.999


def test_missing_signal_is_not_amplified_to_reference_loudness(tmp_path):
    time = np.arange(16000 * 2) / 16000
    source = _write(tmp_path, "silence", np.zeros(len(time)))
    reference = _write(tmp_path, "reference", 0.2 * np.sin(2 * np.pi * 700 * time))
    target = tmp_path / "master.wav"
    result = deliver_master(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        source,
        target,
        threading.Event(),
        reference=reference,
    )
    assert result["globalGainDb"] == 0
    np.testing.assert_array_equal(sf.read(target)[0], 0)
