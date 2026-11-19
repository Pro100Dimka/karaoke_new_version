"""Final-file metering keeps every oversampled peak without normalizing its output."""

import json
import math
import re
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.domain_errors import DomainError
from backend.infrastructure.process_runner import ProcessResult, ProcessRunner
from backend.recordings.studio_delivery import MasterDelivery
from backend.recordings.studio_master import FfmpegStudioMasterRenderer


def _delivery(path, renderer=None, cancel=None):
    return MasterDelivery(
        renderer or FfmpegStudioMasterRenderer(ProcessRunner()),
        path,
        path,
        path,
        cancel or threading.Event(),
        sf.info(path),
        sf.info(path).channels,
        True,
        False,
        None,
        0,
        np.ones(1, dtype=bool),
        {},
        None,
    )


def _sampled_peak(path):
    result = FfmpegStudioMasterRenderer(ProcessRunner())._mix(
        path,
        path,
        "[0:a]aformat=sample_fmts=dbl:sample_rates=192000[out]",
        ["-c:a", "pcm_f64le", "-f", "f64le", "-"],
        threading.Event(),
    )
    maximum = float(np.max(abs(np.frombuffer(result.stdout, dtype="<f8"))))
    return 20 * math.log10(maximum) if maximum else -math.inf


@pytest.mark.parametrize("rate", [8000, 44100, 48000, 96000, 192000])
@pytest.mark.parametrize("kind", ["end-impulse", "intersample", "noise", "crescendo", "silence"])
def test_final_meter_uses_full_precision_peaks_including_the_resampler_tail(tmp_path, rate, kind):
    time = np.arange(round(3.043 * rate)) / rate
    samples = np.zeros((len(time), 2))
    if kind == "end-impulse":
        samples[-1, 0] = 0.5
    elif kind == "intersample":
        samples[:, 0] = 0.6 * np.sin(2 * np.pi * rate / 4 * time + np.pi / 4)
        samples[:, 1] = -samples[:, 0]
    elif kind == "noise":
        samples = np.random.default_rng(836).normal(0, 0.03, samples.shape)
    elif kind == "crescendo":
        samples[:, 0] = 0.4 * time / time[-1] * np.sin(2 * np.pi * 1000 * time)
    path = tmp_path / "encoded.wav"
    sf.write(path, samples, rate, subtype="PCM_24")
    original = path.read_bytes()
    expected = _sampled_peak(path)
    if kind == "silence":
        with pytest.raises(DomainError, match="true peak could not be measured"):
            _delivery(path)._verify_peaks()
    else:
        levels = _delivery(path)._verify_peaks()
        assert levels["input_tp"] == pytest.approx(expected, abs=1e-5)
        assert levels["input_lra"] >= 0
    assert path.read_bytes() == original


class _ObservedRunner(ProcessRunner):
    def __init__(self):
        self.results = []

    def run(self, command, **kwargs):
        result = super().run(command, **kwargs)
        self.results.append(result)
        return result


@pytest.mark.parametrize("rate", [44100, 48000])
@pytest.mark.parametrize("duration,sparse", [(0.083, False), (3.043, False), (8.21, True)])
def test_meter_reports_measured_stats_without_rendering_discarded_dynamic_gain(
    tmp_path, rate, duration, sparse
):
    time = np.arange(round(duration * rate)) / rate
    samples = 0.1 * np.sin(2 * np.pi * 1000 * time)
    if sparse:
        samples[: -round(0.005 * rate)] = 0
    path = tmp_path / "encoded.wav"
    sf.write(path, samples, rate, subtype="PCM_24")
    runner = _ObservedRunner()
    levels = _delivery(path, FfmpegStudioMasterRenderer(runner))._verify_peaks()
    match = re.search(rb'\{\s*"input_i".*?\}', runner.results[-1].stderr, re.S)
    assert match is not None
    report = json.loads(match.group())
    assert report["normalization_type"] == "linear"
    assert report["input_i"] == report["output_i"]
    assert report["input_lra"] == report["output_lra"]
    assert levels["input_lra"] < 0.1
    if duration == 3.043:
        assert levels["input_i"] == pytest.approx(-23, abs=0.1)
    else:
        assert levels["input_i"] == -math.inf
    assert levels["input_tp"] == pytest.approx(_sampled_peak(path), abs=1e-5)


class _MeterRenderer:
    def __init__(self, peaks, *, missing_peak=False, invalid_loudness=False):
        self.peaks = iter(peaks)
        self.missing_peak = missing_peak
        self.invalid_loudness = invalid_loudness
        self.encodes = []
        self.measurements = 0

    def _mix(self, first, second, graph, output, cancel, **kwargs):
        if output[-1] != "-":
            self.encodes.append(graph)
            return ProcessResult(0, b"", b"")
        self.measurements += 1
        peak = next(self.peaks)
        loudness = {
            "input_i": "-18.00",
            "input_lra": "2.00",
            "input_tp": f"{peak:.2f}",
            "input_thresh": "-28.00",
            "target_offset": "4.00",
        }
        summary = b"not loudness" if self.invalid_loudness else json.dumps(loudness).encode()
        if not self.missing_peak:
            summary += f"\n[Parsed_astats_1 @ 0xabcd] Peak level dB: {peak:.6f}\n".encode()
        return ProcessResult(0, b"", summary)


def _fake_delivery(tmp_path, renderer):
    path = tmp_path / "encoded.wav"
    sf.write(path, np.zeros(8000), 8000)
    delivery = _delivery(path, renderer)
    delivery.graph = "[0:a]alimiter=limit=0.891251:level=0[out]"
    return delivery


def test_peak_ceiling_is_checked_before_rounding_and_reencodes_when_needed(tmp_path):
    renderer = _MeterRenderer([-0.9996, -1.1004])
    levels = _fake_delivery(tmp_path, renderer)._verify_peaks()
    assert levels["input_tp"] == -1.1004
    assert renderer.measurements == 2
    assert len(renderer.encodes) == 1
    assert "limit=0.891251" not in renderer.encodes[0]


@pytest.mark.parametrize("missing_peak,invalid_loudness", [(True, False), (False, True)])
def test_incomplete_meter_output_never_verifies_a_master(tmp_path, missing_peak, invalid_loudness):
    renderer = _MeterRenderer([-1.2], missing_peak=missing_peak, invalid_loudness=invalid_loudness)
    with pytest.raises(DomainError, match="true peak could not be measured"):
        _fake_delivery(tmp_path, renderer)._verify_peaks()
    assert not renderer.encodes


def test_peak_verification_still_stops_after_three_failed_attempts(tmp_path):
    renderer = _MeterRenderer([-0.4, -0.5, -0.6])
    with pytest.raises(DomainError, match="exceeds the true-peak ceiling"):
        _fake_delivery(tmp_path, renderer)._verify_peaks()
    assert renderer.measurements == 3
    assert len(renderer.encodes) == 2


def test_cancelled_final_verification_preserves_the_encoded_file(tmp_path):
    path = tmp_path / "encoded.wav"
    sf.write(path, np.zeros(8000), 8000)
    original = path.read_bytes()
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(DomainError) as raised:
        _delivery(path, cancel=cancel)._verify_peaks()
    assert raised.value.code == "ProcessCancelled"
    assert path.read_bytes() == original
