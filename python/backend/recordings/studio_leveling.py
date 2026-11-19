"""Local syllable control, independent of the slower vocal/backing placement."""

import numpy as np
from scipy.ndimage import median_filter


def _soft_excess(values: np.ndarray, threshold: float, knee: float) -> np.ndarray:
    above = values - threshold
    return np.asarray(
        np.where(
            above <= -knee / 2,
            0.0,
            np.where(above >= knee / 2, above, (above + knee / 2) ** 2 / (2 * knee)),
        ),
        dtype=float,
    )


def local_outlier_gain(
    levels: np.ndarray, baseline: np.ndarray, active: np.ndarray, frame_seconds: float
) -> np.ndarray:
    # A short median rejects isolated accents without inverting each sample of
    # a normal phrase envelope. Inactive gaps are not evidence for a quiet word.
    positions = np.arange(len(levels))
    context = np.interp(positions, positions[active], levels[active])
    window = max(3, round(0.4 / frame_seconds) // 2 * 2 + 1)
    context = median_filter(context, size=window, mode="nearest")
    # A short sung word can be surrounded by audible breaths. Its local median
    # then measures breath level, so require an outlier above the voiced phrase too.
    reference = np.maximum(context, baseline)
    reduction = np.minimum(_soft_excess(levels - reference, 0.5, 1.0) * 0.95, 18.0)
    # A quiet sustained word may outlast the local median, so retain the slower
    # phrase context for upward control. Breath protection is applied afterwards.
    lift = np.minimum(_soft_excess(reference - levels, 2.0, 2.0) * 0.75, 12.0)
    return np.asarray(lift - reduction, dtype=float)


def correction_response(values: np.ndarray, frame_seconds: float) -> np.ndarray:
    """Catch local peaks promptly and recover without borrowing future reductions."""
    result = np.asarray(values, dtype=float).copy()
    recovery = 1 - np.exp(-frame_seconds / 0.03)
    for index in range(1, len(result)):
        previous = result[index - 1]
        if result[index] > previous:
            result[index] = previous + recovery * (result[index] - previous)
    return result
