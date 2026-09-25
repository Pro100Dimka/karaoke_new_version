from __future__ import annotations

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
