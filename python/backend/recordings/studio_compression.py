from __future__ import annotations
import numpy as np
from numpy.typing import NDArray
from scipy.ndimage import median_filter
from backend.recordings.studio_audio import _PROFILE_SECONDS


def _transition_durations(
    values: np.ndarray, low: float, high: float
) -> tuple[list[float], list[float]]:
    changes: dict[tuple[bool, bool], list[float]] = {(False, True): [], (True, False): []}
    previous: bool | None = None
    previous_index = 0
    for index in np.flatnonzero((values <= low) | (values >= high)):
        state = bool(values[index] >= high)
        if previous is not None and state != previous:
            changes[previous, state].append(float(index - previous_index) * _PROFILE_SECONDS * 1000)
        previous, previous_index = state, int(index)
    return changes[False, True], changes[True, False]


def _reference_compressor_timing(reference: NDArray[np.float64]) -> dict[str, float | str]:
    """Estimate response times from sustained reference-vocal level transitions.

    This is an envelope-based proxy, not identification of a studio compressor.
    Guardrails prevent pathological timings when a phrase has no usable edges.
    """
    values = np.asarray(reference, dtype=np.float64)
    values = values[np.isfinite(values)]
    if values.size < 30:
        return {"timingMethod": "insufficient-reference", "attackMs": 0.0, "releaseMs": 0.0}
    # Suppress individual syllable peaks; retain the phrase-level envelope.
    smooth = median_filter(values, size=3, mode="nearest")
    low, high = np.percentile(smooth, [20, 85])
    if high - low < 5:
        return {"timingMethod": "insufficient-contrast", "attackMs": 0.0, "releaseMs": 0.0}
    # Duration between 20% and 80% of each clearly rising/falling transition.
    lo = low + 0.2 * (high - low)
    hi = low + 0.8 * (high - low)
    rises, falls = _transition_durations(smooth, lo, hi)
    if not rises or not falls:
        return {"timingMethod": "insufficient-transitions", "attackMs": 0.0, "releaseMs": 0.0}
    # Dynamics are slower than a 100ms RMS frame; estimate only broad behavior.
    # The FFmpeg compressor has its own permissible parameter ranges.
    attack = float(np.clip(np.median(rises) * 0.15, 5, 100))
    release = float(np.clip(np.median(falls) * 0.75, 50, 1000))
    return {
        "timingMethod": "reference-phrase-envelope",
        "attackMs": attack,
        "releaseMs": release,
        "risingEdges": len(rises),
        "fallingEdges": len(falls),
    }


def _compression_activity(levels: NDArray[np.float64]) -> NDArray[np.float64]:
    values = np.asarray(levels, dtype=np.float64)
    values = values[np.isfinite(values)]
    if values.size < 20:
        return np.empty(0, dtype=np.float64)
    low, high = np.percentile(values, [20, 85])
    return np.asarray(values[values > low + 0.35 * (high - low)], dtype=np.float64)


def _reference_compression(
    recorded: NDArray[np.float64], reference: NDArray[np.float64]
) -> dict[str, float | str]:
    """Estimate vocal compression from the two recordings' *active* level spans.

    The original vocal is used only when its level distribution contains enough
    reliable active frames. This is an estimate, not recovery of a plugin preset.
    """

    timing = _reference_compressor_timing(reference)
    voice, original = _compression_activity(recorded), _compression_activity(reference)
    if min(voice.size, original.size) < 10 or timing["timingMethod"] != "reference-phrase-envelope":
        return {
            "method": "insufficient-reference",
            "ratio": 1.0,
            "thresholdDb": float(np.median(recorded[np.isfinite(recorded)]))
            if np.any(np.isfinite(recorded))
            else -60.0,
            **timing,
        }
    v20, v90 = np.percentile(voice, [20, 90])
    r20, r90 = np.percentile(original, [20, 90])
    input_span = float(v90 - v20)
    target_span = float(r90 - r20)
    # Compression cannot increase dynamic range. Do not invent compression when
    # the reference is more dynamic than the recording.
    ratio = float(np.clip(input_span / max(target_span, 1e-6), 1.0, 3.0))
    return {
        "method": "reference-active-dynamics",
        "ratio": ratio,
        "thresholdDb": float(v20),
        "recordedRangeDb": input_span,
        "referenceRangeDb": target_span,
        **timing,
    }
