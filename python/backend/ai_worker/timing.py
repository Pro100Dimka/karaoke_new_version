from __future__ import annotations

import librosa
import numpy as np
from faster_whisper.vad import get_vad_model
from scipy.ndimage import median_filter, uniform_filter1d
from scipy.spatial.distance import cdist

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


def audible_frames(samples: np.ndarray, hop: int) -> np.ndarray:
    """Raw loudness evidence per hop, retaining quiet gaps independently of pitch confidence."""
    level, threshold = _levels(samples, hop)
    return level > threshold


def voiced_frames(samples: np.ndarray, sample_rate: int, hop: int) -> np.ndarray:
    """One flag per hop: is the vocal track audibly active (relative to its own loudest parts), gaps and blips smoothed."""
    step = hop / sample_rate
    active = audible_frames(samples, hop)
    return _without_short_runs(
        _bridged(active, round(_BRIDGED_GAP_SECONDS / step)), round(_MINIMUM_RUN_SECONDS / step)
    )


def singing_frames(
    samples: np.ndarray, instrumental: np.ndarray | None, sample_rate: int, hop: int
) -> np.ndarray:
    """Audible singing supported by either independent speech or spectrally isolated vocal energy.

    Speech detection supplies positive evidence only: a held vowel can be missed by speech models
    while remaining dominant in its own harmonic bands. Accompaniment bleed cannot extend a word
    merely by being audible when both sources instead identify it as instrumental.
    """
    audible = voiced_frames(samples, sample_rate, hop)
    if instrumental is None:
        return audible
    padded = np.pad(samples, (0, -len(samples) % 512))
    probability = get_vad_model()(padded).reshape(-1)
    speech = np.interp(
        np.arange(len(audible)) * hop / sample_rate,
        np.arange(len(probability)) * 512 / sample_rate,
        probability,
    )
    dominance, coherence = _source_evidence(samples, instrumental, sample_rate, hop)
    # The existing 300-ms word-ending pause also smooths changing harmonic bins and vibrato.
    smooth = median_filter(dominance, size=round(0.3 * sample_rate / hop) | 1)
    supported = audible & (
        (speech >= 0.5) | (smooth[: len(audible)] >= 0.5) | (coherence[: len(audible)] <= 0.5)
    )
    return _without_short_runs(
        _bridged(supported, round(_BRIDGED_GAP_SECONDS * sample_rate / hop)),
        round(_MINIMUM_RUN_SECONDS * sample_rate / hop),
    )


def _source_evidence(
    samples: np.ndarray, instrumental: np.ndarray, sample_rate: int, hop: int
) -> tuple[np.ndarray, np.ndarray]:
    """Soft source dominance and the fraction of vocal power linearly explained by backing.

    Low coherence supplies positive evidence for a quiet independent voice even when backing
    dominates the same frequency bands. One second averages phase across many harmonic cycles;
    a fixed phase-shifted or filtered copy of the accompaniment instead remains coherent.
    """
    backing = np.pad(instrumental[: len(samples)], (0, max(0, len(samples) - len(instrumental))))
    vocal_stft = librosa.stft(samples, n_fft=2048, hop_length=hop)
    backing_stft = librosa.stft(backing, n_fft=2048, hop_length=hop)
    vocal_power, backing_power = np.abs(vocal_stft) ** 2, np.abs(backing_stft) ** 2
    mask = vocal_power / (vocal_power + backing_power + 1e-12)
    dominance = (vocal_power * mask).sum(axis=0) / (vocal_power.sum(axis=0) + 1e-12)
    window = round(sample_rate / hop) | 1
    vocal_mean = uniform_filter1d(vocal_power, window, axis=1)
    backing_mean = uniform_filter1d(backing_power, window, axis=1)
    cross = uniform_filter1d(vocal_stft * backing_stft.conj(), window, axis=1)
    coherence = np.clip(np.abs(cross) ** 2 / (vocal_mean * backing_mean + 1e-12), 0, 1)
    # Weight the current sound, so a preceding loud vowel does not count as residual power
    # after it has stopped. The one-second neighbourhood estimates only the transfer relation.
    explained = (coherence * vocal_power).sum(axis=0) / (vocal_power.sum(axis=0) + 1e-12)
    return np.asarray(dominance), np.asarray(explained)


def harmonic_evidence(samples: np.ndarray, sample_rate: int, hop: int) -> tuple[np.ndarray, np.ndarray]:
    """Relative harmonic amplitudes across melody changes, plus reliability of that structure.

    Autocorrelation locates the fundamental; amplitudes use harmonic number rather than absolute
    frequency, so a new note or vibrato need not look like a different source. Weak periodicity is
    unknown evidence, never an indication that the singer stopped.
    """
    spectrum = np.abs(librosa.stft(samples, n_fft=2048, hop_length=hop))
    autocorrelation = np.fft.irfft(spectrum**2, axis=0)
    first, last = round(sample_rate / 1100), round(sample_rate / 65)
    lag = autocorrelation[first:last].argmax(axis=0) + first
    periodicity = autocorrelation[lag, np.arange(len(lag))] / np.maximum(autocorrelation[0], 1e-12)
    bins = np.arange(1, 17)[:, None] * (sample_rate / lag)[None, :] * 2048 / sample_rate
    indices = np.clip(np.rint(bins).astype(int), 2, spectrum.shape[0] - 3)
    # Neighbouring bins accommodate finite FFT resolution; the existing brief-gap scale smooths vibrato.
    peaks = np.maximum.reduce([
        np.take_along_axis(spectrum, indices + delta, axis=0) for delta in range(-2, 3)
    ])
    envelope = median_filter(np.sqrt(peaks), size=(1, 11)).T
    envelope /= np.maximum(np.linalg.norm(envelope, axis=1, keepdims=True), 1e-12)
    return envelope, periodicity


def continued_frames(
    active: np.ndarray, evidence: tuple[np.ndarray, np.ndarray] | None,
    bounds: tuple[float, float, float], step: float,
) -> np.ndarray:
    """Reject a different periodic source after a word, retaining uncertain and matching frames.

    The word's own recognized interval supplies its reference variation, rather than a song-specific
    distance or duration. Consonants and noisy frames cannot broaden that harmonic reference; if the
    core has no reliable periodic structure, the existing independent activity remains authoritative.
    """
    if evidence is None:
        return active
    envelope, periodicity = evidence
    start, end, limit = bounds
    first, stop = int(start / step), min(len(active), int(limit / step))
    last = max(first + 1, min(stop, int(end / step)))
    reference = envelope[first:last][periodicity[first:last] >= 0.5]
    if len(reference) < 2:
        return active
    radius = np.percentile(cdist(reference, reference), 95)
    distance = cdist(envelope[first:stop], reference).min(axis=1)
    matching = (distance <= radius) | (periodicity[first:stop] < 0.5)
    result = active.copy()
    result[first:stop] &= matching
    return _bridged(result, round(_BRIDGED_GAP_SECONDS / step))


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
        np.diff(np.concatenate(([False], flags == value, [False])).astype(np.int8))
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
