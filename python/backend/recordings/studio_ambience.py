"""Bounded vocal ducking for reconstructed ambience, without moving audio."""

from collections.abc import Iterable
import math

import numpy as np
from numpy.typing import NDArray


class WetReturnDucker:
    """Lower wet returns under articulation and let the original tail recover.

    The 3 dB limit is a conservative mixing policy, not a reference measurement.
    A linked 5 ms RMS detector follows the dry voice at its own recording level.
    Only its control signal has latency; neither dry audio nor echoes are delayed.
    """

    limit_db = 3.0
    attack_seconds = 0.015
    release_seconds = 0.15

    def __init__(self, rate: int, level: float) -> None:
        self.rate, self.level = rate, level
        self.window = max(1, round(rate * 0.005))
        self.frames = 0
        self.power = self.target = self.reduction = self.maximum = 0.0

    def gains(self, dry: np.ndarray) -> NDArray[np.float64]:
        output = np.ones(len(dry), dtype=np.float64)
        if self.level <= 0:
            return output
        power = np.mean(dry.astype(np.float64) ** 2, axis=1)
        offset = 0
        while offset < len(dry):
            count = min(self.window - self.frames, len(dry) - offset)
            output[offset : offset + count] = self._advance(count)
            self.power += float(np.sum(power[offset : offset + count]))
            self.frames += count
            offset += count
            if self.frames == self.window:
                relative = math.sqrt(self.power / self.window) / self.level
                self.target = self.limit_db * float(np.clip((relative - 0.15) / 0.85, 0, 1))
                self.frames, self.power = 0, 0.0
        return output

    def _advance(self, count: int) -> NDArray[np.float64]:
        seconds = self.attack_seconds if self.target > self.reduction else self.release_seconds
        decay = np.exp(-np.arange(1, count + 1, dtype=np.float64) / (self.rate * seconds))
        reduction = self.target + (self.reduction - self.target) * decay
        self.reduction = float(reduction[-1])
        self.maximum = max(self.maximum, float(np.max(reduction)))
        return np.asarray(10 ** (-reduction / 20), dtype=np.float64)

    def report(self, buses: Iterable[str]) -> dict[str, object]:
        selected = sorted(buses)
        return {
            "applied": bool(selected and self.maximum > 0),
            "method": "dry-triggered-ambience-return",
            "buses": selected,
            "maximumReductionDb": self.maximum if selected else 0.0,
            "limitDb": self.limit_db,
            "attackMs": self.attack_seconds * 1000,
            "releaseMs": self.release_seconds * 1000,
            "dryPreserved": True,
            "measuredEchoesPreserved": True,
        }
