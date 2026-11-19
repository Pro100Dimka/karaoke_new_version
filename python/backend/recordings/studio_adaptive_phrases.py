"""Reference levels describe phrases, not another singer's phoneme envelope."""

from __future__ import annotations

import numpy as np

from backend.recordings.studio_adaptive_features import regions

STEP = 0.1
WINDOW_SECONDS = 3.0
MAX_RIDE_DB_PER_SECOND = 2.0


def phrase_regions(active: np.ndarray) -> list[tuple[int, int]]:
    joined = active.copy()
    for start, end in regions(~active):
        if start > 0 and end < len(active) and end - start <= round(0.4 / STEP):
            joined[start:end] = True
    return regions(joined)


def _core(levels: np.ndarray, active: np.ndarray) -> np.ndarray:
    if not active.any():
        return np.zeros(len(levels), dtype=bool)
    # Keep this floor fixed for the phrase. A sliding floor would reclassify a
    # quiet reference release as new singing when the original singer stops.
    floor = float(np.percentile(levels[active], 75)) - 12
    return active & (levels >= floor)


def recording_presence_weights(
    voice: np.ndarray,
    reference: np.ndarray,
    active: np.ndarray,
    reference_active: np.ndarray,
    supported: np.ndarray,
    reference_supported: np.ndarray,
) -> np.ndarray:
    own, expected = _core(voice, active), _core(reference, reference_active)
    own_support = float(np.mean(supported[own])) if own.any() else 0.0
    ref_support = float(np.mean(reference_supported[expected])) if expected.any() else 0.0
    # The level scale is fixed for the take. A marginally darker phrase must not
    # switch from word-band to broadband and suddenly inherit its bass offset.
    return np.full(len(voice), float(min(own_support, ref_support) >= 0.6))


def supported_reference_phrases(
    active: np.ndarray,
    reference_active: np.ndarray,
    supported: np.ndarray,
    reference_supported: np.ndarray,
) -> np.ndarray:
    trusted = np.zeros(len(active), dtype=bool)
    for start, end in phrase_regions(active):
        own, expected = active[start:end], reference_active[start:end]
        own_support = float(np.mean(supported[start:end][own])) if own.any() else 0.0
        ref_support = (
            float(np.mean(reference_supported[start:end][expected])) if expected.any() else 0.0
        )
        if min(own_support, ref_support) >= 0.4:
            trusted[start:end] = True
    return trusted


def _window_target(
    voice: np.ndarray,
    reference: np.ndarray,
    music_scale: np.ndarray,
    own_core: np.ndarray,
    reference_core: np.ndarray,
) -> float | None:
    own_count, ref_count = np.count_nonzero(own_core), np.count_nonzero(reference_core)
    minimum = min(3, len(voice))
    if own_count < minimum or ref_count < max(minimum, own_count * 0.5):
        return None
    # The music contribution uses the SAME positions for both backings. Different
    # syllable timing against a drum hit must not manufacture a volume offset.
    return float(
        np.median(reference[reference_core]) - np.median(voice[own_core]) + np.median(music_scale)
    )


def _supported_curve(positions: np.ndarray, targets: np.ndarray, length: int) -> np.ndarray:
    valid = np.flatnonzero(np.isfinite(targets))
    if not len(valid):
        return np.full(length, np.nan)
    result = np.full(length, targets[valid[0]])
    for previous, current in zip(valid, valid[1:]):
        left, right = positions[previous], positions[current]
        if current == previous + 1:
            result[left:right] = np.linspace(
                targets[previous], targets[current], right - left, endpoint=False
            )
        else:
            # Missing evidence is a hold, not a ramp toward a later sung section.
            result[left:right] = targets[previous]
        result[right:] = targets[current]
    maximum_step = MAX_RIDE_DB_PER_SECOND * STEP
    for index in range(1, len(result)):
        result[index] = np.clip(
            result[index], result[index - 1] - maximum_step, result[index - 1] + maximum_step
        )
    return result


def _phrase_targets(
    voice: np.ndarray,
    reference: np.ndarray,
    music_scale: np.ndarray,
    active: np.ndarray,
    reference_active: np.ndarray,
) -> np.ndarray:
    own_core, reference_core = _core(voice, active), _core(reference, reference_active)
    half = round(WINDOW_SECONDS / STEP / 2)
    positions, targets = np.arange(0, len(voice), half), []
    width = min(len(voice), half * 2 + 1)
    for center in positions:
        # Edge anchors use all the available context, not half a window. Otherwise
        # the first weak reference syllable can still duck a steady user onset.
        start = int(np.clip(center - half, 0, len(voice) - width))
        section = slice(start, start + width)
        target = _window_target(
            voice[section],
            reference[section],
            music_scale[section],
            own_core[section],
            reference_core[section],
        )
        targets.append(target if target is not None else np.nan)
    return _supported_curve(positions, np.asarray(targets), len(voice))


def phrase_gain_targets(
    voice: np.ndarray,
    reference: np.ndarray,
    music_scale: np.ndarray,
    active: np.ndarray,
    reference_active: np.ndarray,
    matched: np.ndarray,
) -> np.ndarray:
    desired = np.full(len(voice), np.nan)
    for start, end in phrase_regions(active):
        desired[start:end] = _phrase_targets(
            voice[start:end],
            reference[start:end],
            music_scale[start:end],
            active[start:end],
            reference_active[start:end],
        )
    reliable = matched & np.isfinite(desired)
    calibration = float(np.median(desired[reliable])) if reliable.any() else 0.0
    # A new unmatched phrase can use the established capture calibration, but
    # cannot acquire a new local target from absent reference syllables.
    return np.where(np.isfinite(desired), desired, calibration)


def section_ratio_errors(
    voice: np.ndarray, music: np.ndarray, reference_ratios: np.ndarray, matched: np.ndarray
) -> np.ndarray:
    errors = []
    size = round(WINDOW_SECONDS / STEP)
    for start in range(0, len(voice), size):
        section = slice(start, start + size)
        supported = matched[section]
        if np.count_nonzero(supported) >= min(3, len(supported)):
            actual = (voice - music)[section][supported]
            reference = reference_ratios[section][supported]
            errors.append(abs(float(np.median(actual) - np.median(reference))))
    return np.asarray(errors)
