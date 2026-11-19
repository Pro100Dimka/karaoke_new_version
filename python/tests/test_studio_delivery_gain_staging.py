"""Valid capture attenuation cannot alter glue or loudness integration."""

from pathlib import Path
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_adaptive_delivery import deliver_master
from backend.recordings.studio_master import FfmpegStudioMasterRenderer


def _write(root: Path, name: str, samples: np.ndarray, rate: int = 16000) -> Path:
    path = root / f"{name}.wav"
    sf.write(path, samples, rate, subtype="FLOAT")
    return path


@pytest.mark.parametrize("with_peak", [False, True])
def test_dynamic_delivery_keeps_sections_and_glue_under_capture_attenuation(tmp_path, with_peak):
    rate = 16000
    time = np.arange(rate * 12) / rate
    envelope = np.repeat([1, 0.08, 0.2, 0.08, 0.12, 0.4, 0.08, 0.2, 0.08, 0.12, 0.4, 0.08], rate)
    signal = envelope * (
        0.12 * np.sin(2 * np.pi * 700 * time) + 0.08 * np.sin(2 * np.pi * 1100 * time)
    )
    if with_peak:
        signal[rate * 7] = 0.9
    reference = _write(tmp_path, "reference", signal)
    renderer = FfmpegStudioMasterRenderer(ProcessRunner())
    outputs, reports = [], []
    for gain in (1.0, 0.01):
        source = _write(tmp_path, f"source-{gain}", signal * gain)
        target = tmp_path / f"master-{gain}.wav"
        before = source.read_bytes()
        reports.append(
            deliver_master(renderer, source, target, threading.Event(), reference=reference)
        )
        outputs.append(sf.read(target)[0])
        assert source.read_bytes() == before
    assert reports[1]["integratedLufs"] == pytest.approx(reports[0]["integratedLufs"], abs=0.2)
    assert reports[1]["globalGainDb"] - reports[0]["globalGainDb"] == pytest.approx(40, abs=0.2)
    levels = [10 * np.log10(np.mean(samples.reshape(12, rate) ** 2, axis=1)) for samples in outputs]
    np.testing.assert_allclose(levels[1], levels[0], atol=0.25)
    reductions = [report["glueCompression"]["maxReductionDb"] for report in reports]
    assert reductions[0] > 0.5
    assert reductions[1] == pytest.approx(reductions[0], abs=0.05)
    assert all(report["plannedLimiterReductionDb"] <= 2.001 for report in reports)
    assert all(report["truePeakDbtp"] <= -1 for report in reports)


@pytest.mark.parametrize("case", ["silence", "gated", "short", "sparse-tail"])
def test_gain_staging_cannot_promote_unmetered_input_to_a_loud_reference(tmp_path, case):
    rate = 16000
    time = np.arange(round(rate * (0.2 if case == "short" else 2))) / rate
    samples = np.zeros(len(time))
    if case in ("gated", "short"):
        samples = (0.02 if case == "short" else 0.000001) * np.sin(2 * np.pi * 700 * time)
    if case == "sparse-tail":
        samples[-rate // 20 :] = 0.000003 * np.sin(2 * np.pi * 700 * time[-rate // 20 :])
    source = _write(tmp_path, "source", samples)
    reference = _write(
        tmp_path, "reference", 0.2 * np.sin(2 * np.pi * 700 * np.arange(rate * 2) / rate)
    )
    target = tmp_path / "master.wav"
    result = deliver_master(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        source,
        target,
        threading.Event(),
        reference=reference,
    )
    actual, actual_rate = sf.read(target)
    assert result["inputIntegratedLufs"] is None
    assert result["globalGainDb"] == 0
    assert actual_rate == rate and len(actual) == len(samples)
    if case == "short":
        # Compare like-for-like oversampled peaks, not pre/post resampler samples.
        assert result["truePeakDbtp"] <= result["inputTruePeakDbtp"] + 0.1
    else:
        assert np.max(abs(actual)) <= np.max(abs(samples)) + 2e-7
