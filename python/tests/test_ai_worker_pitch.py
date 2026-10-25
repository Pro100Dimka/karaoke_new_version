from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import torch

from backend.ai_worker.pitch import _pitch_points


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
