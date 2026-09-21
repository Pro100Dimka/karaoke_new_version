from __future__ import annotations

import numpy as np

_ACTIVITY_DB = 30.0
_ABSOLUTE_FLOOR_DB = -65.0
_BRIDGED_GAP_SECONDS = 0.12
_MINIMUM_RUN_SECONDS = 0.05


def voiced_frames(samples: np.ndarray, sample_rate: int, hop: int) -> np.ndarray:
    """One flag per hop: is the vocal track audibly active (relative to its own loudest parts), gaps and blips smoothed."""
    frame = hop * 2
    padded = np.pad(samples, (frame // 2, frame // 2))
    count = 1 + (len(padded) - frame) // hop
    windows = np.lib.stride_tricks.as_strided(
        padded, shape=(count, frame), strides=(padded.strides[0] * hop, padded.strides[0])
    )
    rms = np.sqrt(np.mean(windows.astype(np.float64) ** 2, axis=1) + 1e-12)
    level = 20.0 * np.log10(rms)
    threshold = max(_ABSOLUTE_FLOOR_DB, float(np.percentile(level, 95)) - _ACTIVITY_DB)
    step = hop / sample_rate
    active = level > threshold
    return _without_short_runs(
        _bridged(active, round(_BRIDGED_GAP_SECONDS / step)), round(_MINIMUM_RUN_SECONDS / step)
    )


def _runs(flags: np.ndarray, value: bool) -> list[tuple[int, int]]:
    edges = np.flatnonzero(
        np.diff(np.concatenate(([not value], flags == value, [not value])).astype(np.int8))
    )
    return [(int(edges[i]), int(edges[i + 1])) for i in range(0, len(edges) - 1, 2)]


def _bridged(active: np.ndarray, gap: int) -> np.ndarray:
    result = active.copy()
    for start, end in _runs(active, False):
        if 0 < start and end < len(active) and end - start <= gap:
            result[start:end] = True
    return result


def _without_short_runs(active: np.ndarray, minimum: int) -> np.ndarray:
    result = active.copy()
    for start, end in _runs(active, True):
        if end - start < minimum:
            result[start:end] = False
    return result
