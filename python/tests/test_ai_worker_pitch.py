from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import torch

from backend.ai_worker.pitch import _pitch_points


@pytest.mark.parametrize("kind", ["tone", "quiet", "breathy", "noise"])
@pytest.mark.parametrize("duration", [0.03, 0.07, 0.11])
def test_short_pitch_bursts_need_acoustic_periodicity(monkeypatch, kind, duration):
    from backend.ai_worker import pitch as worker

    rate = 16000
    samples = np.zeros(rate, dtype=np.float32)
    axis = np.arange(round(duration * rate)) / rate
    noise = np.random.default_rng(42).normal(size=len(axis))
    tone = np.sin(2 * np.pi * 220 * axis)
    burst = {
        "tone": 0.3 * tone,
        "quiet": 0.002 * tone,
        "breathy": 0.3 * tone + 0.1 * noise,
        "noise": 0.3 * noise,
    }[kind]
    samples[6400 : 6400 + len(burst)] = burst
    monkeypatch.setattr(worker, "device", lambda: "cpu")
    monkeypatch.setattr(worker, "read_mono", lambda *_: samples)
    monkeypatch.setattr(
        worker,
        "_predict_active",
        lambda _s, active, _d: (
            torch.full((1, len(active)), 220.0),
            torch.from_numpy(active.astype(np.float32))[None] * 0.9,
        ),
    )

    points = worker.pitch(Path("release.wav"))["points"]
    active = [point for point in points if point["audioActive"]]
    assert active
    if kind == "noise":
        assert all(point["confidence"] < 0.5 for point in active)
    else:
        assert all(point["confidence"] == 0.9 for point in active)


def test_pitch_accelerator_is_opt_in_and_cuda_only(monkeypatch):
    from backend.ai_worker import pitch as worker

    monkeypatch.delenv("AD_VOICE_TENSORRT_PITCH", raising=False)
    calls = []
    monkeypatch.setattr(worker.torchcrepe, "infer", lambda frames, **kw: calls.append(kw))
    worker._pitch_inference("cuda")(torch.zeros(1, 1024))
    monkeypatch.setenv("AD_VOICE_TENSORRT_PITCH", "unused-on-cpu")
    worker._pitch_inference("cpu")(torch.zeros(1, 1024))
    assert calls == [{"model": "full", "device": "cuda"}, {"model": "full", "device": "cpu"}]


def test_pitch_accelerator_pads_only_network_batch_and_trims_output(monkeypatch):
    from backend.ai_worker.tensorrt_pitch import TensorRTPitch

    model = TensorRTPitch.__new__(TensorRTPitch)
    frames = torch.randn(7, 1024)
    seen = []

    def execute(value):
        seen.append(value)
        return torch.arange(128 * 360).reshape(128, 360)

    monkeypatch.setattr(model, "_execute", execute)
    result = model(frames)
    assert result.shape == (7, 360)
    torch.testing.assert_close(seen[0][:7], frames, rtol=0, atol=0)
    assert torch.count_nonzero(seen[0][7:]) == 0
    torch.testing.assert_close(result, execute(seen[0])[:7])


@pytest.mark.parametrize("shape", [(0, 1024), (129, 1024), (128, 512)])
def test_pitch_accelerator_rejects_incompatible_batches(shape):
    from backend.ai_worker.tensorrt_pitch import TensorRTPitch

    model = TensorRTPitch.__new__(TensorRTPitch)
    with pytest.raises(ValueError, match="frames"):
        model(torch.zeros(shape))


class _Vector:
    def __init__(self, values: list[float]) -> None:
        self.values = values
        self.cpu_calls = 0

    def __getitem__(self, index: int) -> "_Vector":
        assert index == 0
        return self

    def detach(self) -> "_Vector":
        return self

    def cpu(self) -> "_Vector":
        self.cpu_calls += 1
        return self

    def tolist(self) -> list[float]:
        return self.values


def test_pitch_points_transfer_each_result_to_cpu_only_once() -> None:
    frequency = _Vector([440.125, 441.875])
    periodicity = _Vector([0.91234, 0.87654])

    points = _pitch_points(frequency, periodicity, step=0.01)

    assert frequency.cpu_calls == 1
    assert periodicity.cpu_calls == 1
    assert points == [
        {"time": 0.0, "frequency": 440.12, "confidence": 0.912},
        {"time": 0.01, "frequency": 441.88, "confidence": 0.877},
    ]


@pytest.mark.parametrize(
    ("frequency", "odd_harmonic", "middle", "expected"),
    [(200, 0.0, 0.0, 200), (200, 0.35, 0.35, 100), (200, 0.35, 0.13, 100), (800, 0.35, 0.35, 200)],
)
def test_pitch_uses_the_supported_octave_with_a_missing_fundamental(
    monkeypatch, frequency, odd_harmonic, middle, expected
):
    from backend.ai_worker import pitch as worker

    time = np.arange(16_000, dtype=np.float32) / 16_000
    odd = np.where((time >= 0.35) & (time < 0.65), middle, odd_harmonic)
    samples = (
        np.sin(time * 2 * np.pi * frequency)
        + odd * np.sin(time * 2 * np.pi * (frequency + expected))
    ).astype(np.float32)
    monkeypatch.setattr(worker, "device", lambda: "cpu")
    monkeypatch.setattr(worker, "read_mono", lambda *_: samples)
    monkeypatch.setattr(
        worker,
        "_predict_active",
        lambda _samples, active, _target: (
            torch.full((1, len(active)), float(frequency)),
            torch.full((1, len(active)), 0.9),
        ),
    )

    points = worker.pitch(Path("vocal.wav"))["points"]

    assert all(point["frequency"] == expected for point in points[25:75])


@pytest.mark.parametrize("length", [0, 1, 16000 * 12 + 73])
def test_inaudible_pitch_skips_the_network_but_keeps_the_timeline(monkeypatch, length):
    from backend.ai_worker import pitch as worker

    calls = []
    monkeypatch.setattr(worker, "device", lambda: "cpu")
    monkeypatch.setattr(worker, "read_mono", lambda *_: np.zeros(length, dtype=np.float32))
    monkeypatch.setattr(
        worker.torchcrepe,
        "infer",
        lambda frames, *args, **kwargs: calls.append(len(frames)) or torch.ones((len(frames), 360)),
    )

    points = worker.pitch(Path("silent.wav"))["points"]

    assert calls == [], "inaudible audio must not spend time in the full pitch network"
    assert len(points) == 1 + length // 160
    assert [point["time"] for point in points] == [round(i * 0.01, 3) for i in range(len(points))]
    assert all(point["frequency"] == point["confidence"] == 0 for point in points)
    assert not any(point["audioActive"] for point in points)


@pytest.mark.parametrize("batch", [128, 512])
def test_skipping_silent_pitch_batches_keeps_quiet_entries_and_decoder_context(monkeypatch, batch):
    from backend.ai_worker import pitch as worker

    samples = np.zeros(160 * (batch * 5 + 9) + 73, dtype=np.float32)
    first, last = 160 * (batch * 2 - 2), 160 * (batch * 2 + 3)
    samples[first:last] = 0.002 * np.sin(np.arange(last - first) * 2 * np.pi * 220 / 16000)
    inferred = []
    monkeypatch.setattr(worker, "device", lambda: "cpu")
    monkeypatch.setattr(worker, "_BATCH", {"cpu": batch})
    monkeypatch.setattr(worker, "read_mono", lambda *_: samples)

    def infer(frames, *args, **kwargs):
        inferred.append(frames.clone())
        return torch.ones((len(frames), 360))

    monkeypatch.setattr(worker.torchcrepe, "infer", infer)
    monkeypatch.setattr(
        worker.torchcrepe,
        "postprocess",
        lambda probabilities, *args, **kwargs: (
            torch.full((1, probabilities.shape[-1]), 220.0),
            torch.full((1, probabilities.shape[-1]), 0.9),
        ),
    )
    expected = list(
        worker.torchcrepe.preprocess(torch.from_numpy(samples)[None], 16000, 160, batch)
    )

    points = worker.pitch(Path("quiet-entry.wav"))["points"]

    assert len(inferred) == 2, "only the two batches around this quiet entry need inference"
    for actual, original in zip(inferred, expected[1:3], strict=True):
        torch.testing.assert_close(actual, original, rtol=0, atol=0)
    active = [point for point in points if point["audioActive"]]
    assert active
    assert all(point["frequency"] == 220.0 and point["confidence"] == 0.9 for point in active)
    assert len(points) == 1 + len(samples) // 160


@pytest.mark.parametrize("batch", [128, 512])
def test_silent_predictions_cannot_erase_a_confident_sung_entry(monkeypatch, batch):
    from backend.ai_worker import pitch as worker

    first = batch - 28
    active = np.arange(batch) >= first
    probabilities = torch.zeros((batch, 360))
    probabilities[:first, 170] = 0.9
    bins = 110 + 2 * torch.arange(28)
    probabilities[torch.arange(first, batch), bins] = 0.8
    monkeypatch.setattr(worker.torchcrepe.convert, "dither", lambda cents: cents)
    monkeypatch.setattr(
        worker.torchcrepe, "preprocess", lambda *_: iter([torch.zeros(batch, 1024)])
    )
    monkeypatch.setattr(worker, "_pitch_inference", lambda _: lambda _: probabilities.clone())

    frequency, confidence = worker._predict_active(np.zeros(batch * 160, np.float32), active, "cpu")

    expected = worker.torchcrepe.convert.bins_to_frequency(bins)
    error = abs(1200 * torch.log2(frequency[0, first:] / expected))
    assert torch.all(confidence[0, first:] >= 0.75), "silence must not suppress a confident entry"
    assert torch.max(error) < 25


def test_quiet_pitch_evidence_is_preserved_for_confidence_smoothing(monkeypatch):
    from backend.ai_worker import pitch as worker

    probabilities = torch.zeros((128, 360))
    probabilities[:, 140] = 0.8
    active = np.ones(128, dtype=bool)
    active[64] = False
    monkeypatch.setattr(worker.torchcrepe, "preprocess", lambda *_: iter([torch.zeros(128, 1024)]))
    monkeypatch.setattr(worker, "_pitch_inference", lambda _: lambda _: probabilities.clone())

    _, confidence = worker._predict_active(np.zeros(128 * 160, np.float32), active, "cpu")

    assert torch.all(confidence >= 0.75), "quiet evidence must not be zeroed before smoothing"
