"""Share raw spatial measurements while keeping pan exclusion separate from calibration."""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import partial
from pathlib import Path
import math
import threading

import numpy as np

from backend.recordings.studio_parallel import ordered_map
from backend.recordings.studio_regional_returns import AmbienceRegion
from backend.recordings.studio_return_audio import ReturnSpan, compact_field_envelopes
from backend.recordings.studio_space_analysis import _field_envelopes


@dataclass(slots=True)
class RegionalFields:
    voice: np.ndarray | None = field(default=None, init=False)

    def measure_pair(
        self, voice: Path, reference: Path, cancel: threading.Event
    ) -> tuple[np.ndarray, np.ndarray]:
        expected, actual = ordered_map(partial(_field_envelopes, cancel=cancel), (reference, voice))
        actual.setflags(write=False)
        self.voice = actual
        return expected, actual


def _calibrate_region(
    voice_energy: np.ndarray,
    path: Path,
    region: AmbienceRegion,
    existing_wet: float,
    added_energy: np.ndarray,
    cancel: threading.Event,
    *,
    span: ReturnSpan | None = None,
) -> tuple[float, float]:
    wet = (
        _field_envelopes(path, cancel, band_index=region.band_index)
        if span is None
        else compact_field_envelopes(path, span, region.band_index, round(region.end * 50), cancel)
    )
    section = slice(round(region.start * 50), round(region.end * 50))
    dry_mid = float(voice_energy[section, region.band_index, 0].sum())
    wet_mid, wet_side = wet[section, 0].sum(axis=0)
    missing = max(0, region.ratio - region.existing_ratio)
    missing_side = max(0, missing * dry_mid - added_energy[section, region.band_index, 1].sum())
    missing_mid = max(0, min(missing, 0.35**2) - existing_wet**2)
    return (
        math.sqrt(missing_mid * dry_mid / max(float(wet_mid), 1e-20)),
        math.sqrt(missing_side / max(float(wet_side), 1e-20)),
    )


def _added_field_energy(
    legacy: list[tuple[str, Path, float]], template: np.ndarray, cancel: threading.Event
) -> np.ndarray:
    energy = np.zeros_like(template)
    for _, path, gain in legacy:
        energy += _field_envelopes(path, cancel) * gain**2
    return energy
