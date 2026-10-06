from __future__ import annotations

import numpy as np

_ACTIVITY_DB = 30.0
_ABSOLUTE_FLOOR_DB = -65.0
_BRIDGED_GAP_SECONDS = 0.12
_MINIMUM_RUN_SECONDS = 0.05
# A voice entering (a new phrase, or a word after a breath or a stop consonant) jumps by at least this
# much over the quietest moment just before it; a held vowel moving to its next note or syllable does not.
_ONSET_RISE_DB = 15.0
_ONSET_LOOKBACK_SECONDS = 0.1
# One entry is reported once: the strongest rise wins and nothing closer to it counts as another one.
_ONSET_SEPARATION_SECONDS = 0.2
# The rise stays near its peak for as long as the silence is still inside the lookback; the entry itself is
# the first moment of that plateau.
_ONSET_PLATEAU_DB = 3.0


def _levels(samples: np.ndarray, hop: int) -> tuple[np.ndarray, float]:
    """Loudness (dB) per hop and the level above which the vocal track counts as audible."""
    frame = hop * 2
    padded = np.pad(samples, (frame // 2, frame // 2))
    count = 1 + (len(padded) - frame) // hop
    windows = np.lib.stride_tricks.as_strided(
        padded, shape=(count, frame), strides=(padded.strides[0] * hop, padded.strides[0])
    )
    rms = np.sqrt(np.mean(windows.astype(np.float64) ** 2, axis=1) + 1e-12)
    level = 20.0 * np.log10(rms)
    return level, max(_ABSOLUTE_FLOOR_DB, float(np.percentile(level, 95)) - _ACTIVITY_DB)


def voiced_frames(samples: np.ndarray, sample_rate: int, hop: int) -> np.ndarray:
    """One flag per hop: is the vocal track audibly active (relative to its own loudest parts), gaps and blips smoothed."""
    level, threshold = _levels(samples, hop)
    step = hop / sample_rate
    active = level > threshold
    return _without_short_runs(
        _bridged(active, round(_BRIDGED_GAP_SECONDS / step)), round(_MINIMUM_RUN_SECONDS / step)
    )


def vocal_onsets(samples: np.ndarray, sample_rate: int, hop: int) -> np.ndarray:
    """Seconds where the voice clearly enters: an audible level at least _ONSET_RISE_DB above the
    quietest moment of the preceding _ONSET_LOOKBACK_SECONDS, in order."""
    level, threshold = _levels(samples, hop)
    step = hop / sample_rate
    lookback = max(1, round(_ONSET_LOOKBACK_SECONDS / step))
    padded = np.concatenate((np.full(lookback, level[0]), level))
    quietest = np.lib.stride_tricks.sliding_window_view(padded, lookback)[: len(level)].min(axis=1)
    rise = np.where(level > threshold, level - quietest, 0.0)
    separation = round(_ONSET_SEPARATION_SECONDS / step)
    taken = np.zeros(len(level), dtype=bool)
    found: list[int] = []
    candidates = [int(index) for index in np.flatnonzero(rise >= _ONSET_RISE_DB)]
    for index in sorted(candidates, key=lambda i: (-rise[i], i)):
        if not taken[max(0, index - separation) : index + separation + 1].any():
            taken[index] = True
            entry = index
            while entry > 0 and rise[entry - 1] >= rise[index] - _ONSET_PLATEAU_DB:
                entry -= 1
            found.append(entry)
    return np.array(sorted(found), dtype=np.float64) * step


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
