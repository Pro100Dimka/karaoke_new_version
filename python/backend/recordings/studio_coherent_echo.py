"""Sparse regional copies require predictive waveform evidence, not envelope lag."""

from dataclasses import dataclass, replace
from functools import partial
from pathlib import Path
import threading

import numpy as np
import soundfile as sf
from scipy.signal import butter, correlate, find_peaks, resample_poly, sosfilt

from backend.recordings.studio_arrangement import ArrangementMap
from backend.recordings.studio_audio import _check_cancel, _temporary_wave
from backend.recordings.studio_parallel import ordered_map
from backend.recordings.studio_regional_evidence import _diffuse_spectrum, _valid_intervals
from backend.recordings.studio_regional_returns import AmbienceRegion, EchoRegion, _input_curve


_RATE = 8000
_CONTEXT_SECONDS = 12.0


@dataclass(frozen=True, slots=True)
class EchoFit:
    delay: float
    left: float
    right: float
    confidence: float


def _read_interval(path: Path, start: float, end: float) -> np.ndarray:
    with sf.SoundFile(path) as source:
        if source.channels != 2 or source.samplerate <= 7000:
            return np.empty((0, 2))
        source.seek(round(start * source.samplerate))
        audio = source.read(
            round((end - start) * source.samplerate), dtype="float32", always_2d=True
        )
        divisor = int(np.gcd(source.samplerate, _RATE))
        return np.asarray(
            resample_poly(audio, _RATE // divisor, source.samplerate // divisor, axis=0),
            dtype=np.float64,
        )


def _band(audio: np.ndarray, bounds: tuple[int, int]) -> np.ndarray:
    return np.asarray(
        sosfilt(butter(2, bounds, fs=_RATE, btype="bandpass", output="sos"), audio, axis=0),
        dtype=np.float64,
    )


def _candidate_lag(audio: np.ndarray) -> int | None:
    mid, side = audio.mean(axis=1), (audio[:, 0] - audio[:, 1]) * 0.5
    energy = float(mid @ mid)
    if energy <= 1e-12:
        return None
    residual = side - mid * float(mid @ side / energy)
    if float(residual @ residual) <= energy * 1e-8:
        return None
    lags = np.arange(round(_RATE * 0.06), min(round(_RATE * 0.6) + 1, len(mid) // 3))
    if not len(lags):
        return None
    cross = correlate(residual, mid, mode="full", method="fft")[len(mid) - 1 :]
    return int(lags[np.argmax(abs(cross[lags]))])


def _model_folds(audio: np.ndarray, lag: int) -> tuple[np.ndarray, float] | None:
    mid, side = audio.mean(axis=1), (audio[:, 0] - audio[:, 1]) * 0.5
    start = 2 * lag
    features = np.column_stack((mid[start:], mid[start - lag : -lag], side[start - lag : -lag]))
    target = side[start:]
    if len(target) < _RATE:
        return None
    partition = (np.arange(len(target)) // (_RATE // 2)) % 2 == 0
    coefficients, scores = [], []
    for training in (partition, ~partition):
        if min(int(training.sum()), int((~training).sum())) < _RATE // 3:
            return None
        if np.linalg.cond(features[training]) > 1e4:
            return None
        fit = np.linalg.lstsq(features[training], target[training], rcond=None)[0]
        direct = np.linalg.lstsq(features[training, :1], target[training], rcond=None)[0]
        error = float(np.mean((features[~training] @ fit - target[~training]) ** 2))
        baseline = float(np.mean((features[~training, :1] @ direct - target[~training]) ** 2))
        power = float(np.mean(target[~training] ** 2))
        score = min(1 - error / max(power, 1e-20), 1 - error / max(baseline, 1e-20))
        if score < 0.8:
            return None
        coefficients.append(fit)
        scores.append(score)
    return np.asarray(coefficients), min(scores)


def _copy_gains(coefficients: np.ndarray) -> tuple[float, float] | None:
    # S[t] = p*M[t] + d*M[t-lag] - c*S[t-lag], where c/d are echo M/S gains.
    mid, side = -coefficients[:, 2], coefficients[:, 1]
    gains = np.column_stack((mid + side, mid - side))
    if np.any(gains < -1e-4) or np.any(gains > 1.0):
        return None
    tolerance = max(0.02, float(np.max(gains)) * 0.2)
    if np.max(abs(gains[0] - gains[1])) > tolerance:
        return None
    left, right = np.maximum(np.mean(gains, axis=0), 0)
    return (float(left), float(right)) if max(left, right) >= 0.015 else None


def _competitor_lags(audio: np.ndarray, lag: int) -> list[int]:
    mid, side = audio.mean(axis=1), (audio[:, 0] - audio[:, 1]) * 0.5
    residual = side - mid * float(mid @ side / max(float(mid @ mid), 1e-20))
    cross = abs(correlate(residual, mid, mode="full", method="fft")[len(mid) - 1 :])
    low, high = round(_RATE * 0.06), min(round(_RATE * 0.6), len(mid) // 3 - 1)
    tolerance = round(_RATE * 0.002)
    peaks = find_peaks(cross[low : high + 1], distance=tolerance)[0] + low
    peaks = peaks[abs(peaks - lag) > tolerance]
    strongest = peaks[np.argsort(cross[peaks])[::-1]][:8]
    return sorted({int(value) for value in (*strongest, low, high) if abs(value - lag) > tolerance})


def _predictive_errors(
    audio: np.ndarray, lag: int, start: int, *, require_condition: bool = False
) -> tuple[np.ndarray, np.ndarray] | None:
    mid, side = audio.mean(axis=1), (audio[:, 0] - audio[:, 1]) * 0.5
    target = side[start:]
    features = np.column_stack((mid[start:], mid[start - lag : -lag], side[start - lag : -lag]))
    partition = (np.arange(len(target)) // (_RATE // 2)) % 2 == 0
    errors, coefficients = [], []
    for training in (partition, ~partition):
        if min(int(training.sum()), int((~training).sum())) < _RATE // 3:
            return None
        if require_condition and np.linalg.cond(features[training]) > 1e4:
            return None
        fit = np.linalg.lstsq(features[training], target[training], rcond=None)[0]
        direct = np.linalg.lstsq(features[training, :1], target[training], rcond=None)[0]
        power = float(np.mean(target[~training] ** 2))
        baseline = float(np.mean((features[~training, :1] @ direct - target[~training]) ** 2))
        normalizer = min(power, baseline)
        if normalizer <= 1e-20:
            return None
        errors.append(
            float(np.mean((features[~training] @ fit - target[~training]) ** 2)) / normalizer
        )
        coefficients.append(fit)
    return np.asarray(errors), np.asarray(coefficients)


def _unique_voiced_copy(audio: np.ndarray, lag: int) -> bool:
    alternatives = _competitor_lags(audio, lag)
    start = 2 * max([lag, *alternatives])
    if not alternatives or len(audio) - start < _RATE:
        return False
    best = _predictive_errors(audio, lag, start, require_condition=True)
    if best is None or np.max(best[0]) > 0.2 or _copy_gains(best[1]) is None:
        return False
    # Every hypothesis uses identical target samples, folds and normalization.
    # A degenerate alternative may still predict a stationary tone perfectly;
    # do not discard it using the winning model's condition/gain requirements.
    bound = 4 * np.maximum(best[0], np.finfo(np.float32).eps)
    for candidate in alternatives:
        other = _predictive_errors(audio, candidate, start)
        if other is None or np.any(other[0] < bound):
            return False
    return True


def _independent_copy_support(audio: np.ndarray, lag: int) -> bool:
    for bounds in ((500, 1000), (1000, 2000), (2000, 3500)):
        observed = _candidate_lag(_band(audio, bounds))
        if observed is None or abs(observed - lag) > round(_RATE * 0.002):
            return False
    width = round(_RATE * 0.24)
    windows = [audio[index : index + width] for index in range(0, len(audio) - width + 1, width)]
    powers = np.array([np.mean(window**2) for window in windows])
    floor = max(1e-12, float(np.max(powers, initial=0)) * 0.1)
    aperiodic = (
        sum(
            _diffuse_spectrum(window, _RATE)
            for window, power in zip(windows, powers)
            if power > floor
        )
        >= 3
    )
    return aperiodic or _unique_voiced_copy(_band(audio, (500, 3500)), lag)


def _fit_echo(path: Path, start: float, end: float, cancel: threading.Event) -> EchoFit | None:
    _check_cancel(cancel)
    if not 2 <= end - start <= _CONTEXT_SECONDS + 1e-6:
        return None
    audio = _read_interval(path, start, end)
    if len(audio) < _RATE * 2:
        return None
    band = _band(audio, (500, 3500))
    lag = _candidate_lag(band)
    model = _model_folds(band, lag) if lag is not None else None
    if model is None or lag is None:
        return None
    gains = _copy_gains(model[0])
    if gains is None or not _independent_copy_support(audio, lag):
        return None
    return EchoFit(lag / _RATE, *gains, model[1])


def _local_contexts(start: float, end: float) -> list[tuple[float, float]]:
    count = max(1, int(np.ceil((end - start) / _CONTEXT_SECONDS)))
    edges = np.linspace(start, end, count + 1)
    return [(float(a), float(b)) for a, b in zip(edges[:-1], edges[1:])]


def _region(
    voice: Path,
    reference: Path,
    start: float,
    end: float,
    validity: tuple[float, float],
    cancel: threading.Event,
) -> EchoRegion | None:
    expected = _fit_echo(reference, start, end, cancel)
    if expected is None:
        return None
    existing = _fit_echo(voice, start, end, cancel)
    return EchoRegion(
        start,
        end,
        expected.delay,
        expected.left,
        expected.right,
        expected.confidence,
        existing_left=existing.left if existing else 0.0,
        existing_right=existing.right if existing else 0.0,
        valid_start=validity[0],
        valid_end=validity[1],
        existing_delay_seconds=existing.delay if existing else None,
    )


def _context_jobs(
    reference: Path, arrangement: ArrangementMap
) -> list[tuple[float, float, tuple[float, float]]]:
    valid = _valid_intervals(0, arrangement.duration_seconds, arrangement)
    reference_end = min(sf.info(reference).duration, arrangement.duration_seconds)
    contexts = []
    for section in arrangement.sections:
        bounds = _valid_intervals(
            section.start_seconds, min(section.end_seconds, reference_end), arrangement
        )
        for start, end in bounds:
            validity = next((a, b) for a, b in valid if a <= start and b >= end)
            for begin, finish in _local_contexts(start, end):
                contexts.append((begin, finish, validity))
    return contexts


def _measure_context(
    voice: Path,
    reference: Path,
    cancel: threading.Event,
    context: tuple[float, float, tuple[float, float]],
) -> EchoRegion | None:
    begin, finish, validity = context
    return _region(voice, reference, begin, finish, validity, cancel)


def plan_coherent_echoes(
    voice: Path, reference: Path | None, arrangement: ArrangementMap, cancel: threading.Event
) -> list[EchoRegion]:
    if reference is None or sf.info(voice).channels != 2:
        return []
    regions = ordered_map(
        partial(_measure_context, voice, reference, cancel), _context_jobs(reference, arrangement)
    )
    return [region for region in regions if region is not None]


def without_echo_regions(
    rooms: list[AmbienceRegion], echoes: list[EchoRegion]
) -> list[AmbienceRegion]:
    result: list[AmbienceRegion] = []
    for room in rooms:
        pieces = [(room.start, room.end)]
        for echo in echoes:
            split = []
            for start, end in pieces:
                if echo.end <= start or echo.start >= end:
                    split.append((start, end))
                else:
                    if start < echo.start:
                        split.append((start, echo.start))
                    if end > echo.end:
                        split.append((echo.end, end))
            pieces = split
        result.extend(replace(room, start=a, end=b) for a, b in pieces)
    return result


def echo_buses(
    voice: Path, work: Path, regions: list[EchoRegion], cancel: threading.Event
) -> tuple[list[tuple[str, Path, float, float]], list[dict[str, object]]]:
    active, reports = [], []
    for region in regions:
        applied = region.existing_delay_seconds is None
        left, right = (region.left_gain, region.right_gain) if applied else (0.0, 0.0)
        reports.append(
            {
                **region.payload(),
                "addedLeftGain": left,
                "addedRightGain": right,
                "decision": "measured-addition" if applied else "existing-coherent-copy-preserved",
                "targetCopyApplied": applied,
            }
        )
        if applied:
            active.append(region)
    if not active:
        return [], reports
    path = work / "coherent-echo.wav"
    _render_echoes(voice, path, active, cancel)
    return [("regional-coherent-echo", path, 1.0, 1.0)], reports


def _excite_copies(
    wet: np.ndarray, mono: np.ndarray, time: np.ndarray, regions: list[EchoRegion], rate: int
) -> None:
    for region in regions:
        if time[-1] < region.start - 0.125 or time[0] > region.end + 0.125:
            continue
        delay = round(region.delay_seconds * rate)
        excitation = mono * _input_curve(time, region)
        wet[delay : delay + len(mono)] += excitation[:, None] * np.array(
            [region.left_gain, region.right_gain]
        )


def _render_echoes(
    voice: Path, target: Path, regions: list[EchoRegion], cancel: threading.Event
) -> None:
    rate = sf.info(voice).samplerate
    maximum = max(round(region.delay_seconds * rate) for region in regions)
    overlap = np.zeros((maximum, 2))
    offset = 0
    with (
        sf.SoundFile(voice) as source,
        _temporary_wave(target, samplerate=rate, channels=2) as output,
    ):
        for block in source.blocks(blocksize=32768, always_2d=True):
            _check_cancel(cancel)
            time = (offset + np.arange(len(block))) / rate
            wet = np.zeros((len(block) + maximum, 2))
            wet[:maximum] = overlap
            _excite_copies(wet, block.mean(axis=1), time, regions, rate)
            output.write(wet[: len(block)])
            overlap = wet[len(block) :].copy()
            offset += len(block)
