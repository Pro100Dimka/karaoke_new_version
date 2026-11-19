"""Conservative temporal-null and stereo-coherence evidence for ambience context."""

from pathlib import Path
import math
import threading

import numpy as np
import soundfile as sf
from scipy.signal import butter, correlate, find_peaks, sosfilt
from scipy.optimize import nnls

from backend.recordings.studio_audio import _check_cancel, _profile
from backend.recordings.studio_arrangement import ArrangementMap
from backend.recordings.studio_field import _delayed_kernel


def _lag_score(mid: np.ndarray, side: np.ndarray) -> float:
    """Maximum Pearson correlation over the same 0–600 ms search for every null."""
    length = len(mid)
    lags = np.arange(min(31, length // 2))
    count = length - lags
    a, b = np.r_[0.0, np.cumsum(mid)], np.r_[0.0, np.cumsum(side)]
    aa, bb = np.r_[0.0, np.cumsum(mid**2)], np.r_[0.0, np.cumsum(side**2)]
    first, second = a[count], b[-1] - b[lags]
    cross = correlate(side, mid, mode="full", method="fft")[length - 1 : length - 1 + len(lags)]
    covariance = cross - first * second / count
    variance = np.maximum(aa[count] - first**2 / count, 0)
    variance *= np.maximum(bb[-1] - bb[lags] - second**2 / count, 0)
    valid = variance > 1e-20
    scores = covariance[valid] / np.sqrt(variance[valid])
    return float(np.max(scores, initial=0))


def _independent_context(mid: np.ndarray, side: np.ndarray) -> bool:
    # At least six context blocks must remain after respecting measured memory.
    # Slow fades and short windows cannot supply independent temporal evidence.
    for width in (25, 50, 75, 100):
        if width * 6 > len(mid):
            break
        scores = [
            abs(float(np.corrcoef(values[:-width], values[width:])[0, 1])) for values in (mid, side)
        ]
        if np.isfinite(scores).all() and max(scores) < 0.8:
            return True
    return False


def _repeated_pulsation(values: np.ndarray) -> bool:
    if len(values) < 12 or float(np.std(values)) < 1e-10:
        return False
    maximum = min(150, len(values) // 3)
    scores = np.array(
        [np.corrcoef(values[:-lag], values[lag:])[0, 1] for lag in range(1, maximum + 1)]
    )
    peaks, _ = find_peaks(scores, prominence=0.2)
    return bool(np.any((peaks >= 4) & (scores[peaks] > 0.9)))


def periodic_ambiguity(values: np.ndarray) -> bool:
    return _repeated_pulsation(np.sqrt(values[:, 0])) or _repeated_pulsation(np.sqrt(values[:, 1]))


def envelope_relatedness(values: np.ndarray) -> float:
    if len(values) < 150 or float(values[:, 0].sum()) < 1e-12:
        return 0.0
    mid, side = np.sqrt(values).T
    if min(float(np.std(mid)), float(np.std(side))) < 1e-10:
        return 0.0
    direct = float(mid @ side / max(float(mid @ mid), 1e-20))
    residual = float(np.sum((side - direct * mid) ** 2) / max(float(side @ side), 1e-20))
    if residual < 0.01 or not _independent_context(mid, side):
        return 0.0
    if _repeated_pulsation(mid) or _repeated_pulsation(side):
        return 0.0
    observed = _lag_score(mid, side)
    # Circular offsets preserve the source's autocorrelation and repeated pulse
    # pattern. Block shuffling alone can falsely certify periodic vocal movement.
    shifts = np.unique(np.linspace(60, len(mid) - 60, min(63, len(mid) - 119)).astype(int))
    null = [_lag_score(mid, np.roll(side, int(shift))) for shift in shifts]
    return observed if observed > max(null, default=1.0) + 1e-6 else 0.0


def coherent_pan(reference: Path, start: float, end: float, cancel: threading.Event) -> bool:
    coherence = []
    with sf.SoundFile(reference) as source:
        source.seek(round(start * source.samplerate))
        count = round((end - start) * source.samplerate)
        band = butter(2, (500, 3500), fs=source.samplerate, btype="bandpass", output="sos")
        state = np.zeros((len(band), 2, 2))
        for block in source.blocks(
            blocksize=round(source.samplerate * 0.1), frames=count, always_2d=True
        ):
            _check_cancel(cancel)
            filtered, state = sosfilt(band, block[:, :2], axis=0, zi=state)
            mid, side = filtered.mean(axis=1), (filtered[:, 0] - filtered[:, 1]) * 0.5
            power = float(mid @ mid) * float(side @ side)
            if power > 1e-20:
                coherence.append(abs(float(mid @ side)) / math.sqrt(power))
    return not coherence or float(np.median(coherence)) > 0.98


def estimate_tempo(backing: Path, cancel: threading.Event) -> tuple[float | None, float]:
    levels = _profile(backing, cancel, frame_seconds=0.02)
    if len(levels) < 250 or np.percentile(levels, 90) - np.percentile(levels, 10) < 5:
        return None, 0.0
    envelope = 10 ** ((levels - np.max(levels)) / 20)
    novelty = np.maximum(0, np.diff(envelope, prepend=envelope[0]))
    energy = float(np.dot(novelty, novelty))
    if energy < 1e-8:
        return None, 0.0
    curve = correlate(novelty, novelty, mode="full", method="fft")[len(novelty) - 1 :] / energy
    low, high = 15, min(51, len(curve))
    peaks, _ = find_peaks(curve[low - 1 : high + 1])
    candidates = peaks + low - 1
    candidates = candidates[(candidates >= low) & (candidates < high)]
    if not len(candidates):
        return None, 0.0
    best = int(candidates[np.argmax(curve[candidates])])
    confidence = float(np.clip(curve[best], 0, 1))
    # Multiple repeated attacks must agree; sustained notes and short fills have no beat proof.
    peaks_in_audio, _ = find_peaks(novelty, height=float(np.max(novelty)) * 0.25, distance=5)
    if len(peaks_in_audio) < 6 or confidence < 0.5:
        return None, confidence
    return 60 / (best * 0.02), confidence


def _shared_shape(values: np.ndarray, kernel: np.ndarray) -> tuple[np.ndarray, float] | None:
    scale = max(float(np.percentile(values[:, 0], 85)), 1e-10)
    mid, side = (values / scale).T
    shape = kernel / max(float(kernel.sum()), 1e-20)
    delayed = np.convolve(mid, shape)[: len(mid)]
    features = np.column_stack((mid, delayed))
    partition = (np.arange(len(mid)) // 150) % 2 == 0
    gains, scores = [], []
    for training in (partition, ~partition):
        if not training.any() or training.all():
            return None
        base, _ = nnls(features[training, :1], side[training])
        fit, _ = nnls(features[training], side[training])
        base_error = float(np.mean((features[~training, :1] @ base - side[~training]) ** 2))
        error = float(np.mean((features[~training] @ fit - side[~training]) ** 2))
        if base_error <= 1e-20 or error >= float(np.var(side[~training])) * 0.95:
            return None
        scores.append(1 - error / base_error)
        gains.append(fit[1])
    if min(scores) < 0.05:
        return None
    return shape * float(np.mean(gains)), min(scores)


def _fit_model(
    values: np.ndarray, prior: tuple[np.ndarray, float] | None
) -> tuple[np.ndarray, float, str] | None:
    if periodic_ambiguity(values):
        return None
    fit = _delayed_kernel(values)
    if fit is not None:
        return *fit, "local-delayed-energy-cross-validation"
    if prior is None:
        return None
    fit = _shared_shape(values, prior[0])
    return (*fit, "shared-response-shape-with-local-calibration") if fit is not None else None


def _section_evidence(
    values: np.ndarray, prior: tuple[np.ndarray, float] | None
) -> tuple[np.ndarray, float, str] | None:
    if len(values) < 300 or float(values[:, 0].sum()) <= 1e-12:
        return None
    full = _fit_model(values, prior)
    if full is not None or len(values) < 400:
        return full
    # Production transitions and the preceding effect tail can contaminate the
    # region boundary. One bounded inner context must pass the same evidence gate.
    inner = _fit_model(values[50:-50], prior)
    return (*inner[:2], "inner-context-" + inner[2]) if inner is not None else None


def _valid_intervals(
    start: float, end: float, arrangement: ArrangementMap
) -> list[tuple[float, float]]:
    times = arrangement.times
    selected = (times >= start) & (times < end) & arrangement.reference_valid
    edges = np.flatnonzero(np.diff(np.r_[False, selected, False].astype(int)))
    return [
        (max(start, float(times[begin]) - 0.125), min(end, float(times[finish - 1]) + 0.125))
        for begin, finish in zip(edges[::2], edges[1::2])
    ]


def _global_priors(
    expected: np.ndarray, arrangement: ArrangementMap
) -> list[tuple[np.ndarray, float] | None]:
    intervals = _valid_intervals(0, arrangement.duration_seconds, arrangement)
    priors = []
    for index in range(2):
        fits = []
        for start, end in intervals:
            values = expected[round(start * 50) : round(end * 50), index]
            fit = (
                _delayed_kernel(values)
                if len(values) >= 300 and not periodic_ambiguity(values)
                else None
            )
            if fit is not None:
                fits.append((fit[1] * values[:, 1].sum(), fit))
        priors.append(max(fits, key=lambda item: item[0])[1] if fits else None)
    return priors
