"""Conservative regional evidence for near-unison vocals beyond a fixed stereo response."""

from dataclasses import dataclass
from pathlib import Path
import math
import threading

import numpy as np
from numpy.typing import NDArray
import soundfile as sf
from scipy.ndimage import gaussian_filter1d
from scipy.signal import find_peaks, resample_poly

from backend.domain_errors import DependencyError
from backend.recordings.studio_audio import _check_cancel
from backend.recordings.studio_layer_types import VocalLayerRegion
from backend.recordings.studio_spectrum import measure_stereo_response

_RATE, _SIZE, _HOP = 8000, 1280, 320
_WINDOW = np.hanning(_SIZE)
_WINDOW_CORRELATION = np.fft.irfft(abs(np.fft.rfft(_WINDOW, 2 * _SIZE)) ** 2)[:161]
_BINS = np.arange(round(350 * 2 * _SIZE / _RATE), round(3500 * 2 * _SIZE / _RATE))
_SHIFTS = np.arange(-40, 41, 5)


@dataclass(frozen=True, slots=True)
class _Evidence:
    times: NDArray[np.float64]
    mid_db: NDArray[np.float64]
    side_db: NDArray[np.float64]
    residual: NDArray[np.float64]
    mid_pitch: NDArray[np.float64]
    mid_confidence: NDArray[np.float64]
    side_pitch: NDArray[np.float64]
    side_confidence: NDArray[np.float64]
    similarity: NDArray[np.float64]
    detune: NDArray[np.float64]
    shift_improvement: NDArray[np.float64]


def _pitch(power: NDArray[np.float64]) -> NDArray[np.float64]:
    correlation = np.fft.irfft(power, n=2 * _SIZE, axis=-1)[:, :161]
    correlation /= np.maximum(correlation[:, :1], 1e-20)
    correlation *= _WINDOW_CORRELATION[0] / _WINDOW_CORRELATION
    result = np.zeros((len(power), 2))
    for index, row in enumerate(correlation):
        peaks = find_peaks(row)[0]
        peaks = peaks[(peaks >= 10) & (peaks < 160) & (row[peaks] > 0)]
        if not len(peaks):
            continue
        peak = int(peaks[row[peaks] >= float(np.max(row[peaks])) * 0.9][0])
        curvature = min(row[peak - 1] - 2 * row[peak] + row[peak + 1], -1e-12)
        offset = 0.5 * (row[peak - 1] - row[peak + 1]) / curvature
        result[index] = (_RATE / (peak + np.clip(offset, -0.5, 0.5)), row[peak])
    return result


def _harmonic_match(spectra: NDArray[np.complex128]) -> NDArray[np.float64]:
    amplitude = abs(spectra)
    # Remove broad formant/EQ shape before comparing the narrow harmonic family.
    white = np.maximum(amplitude - gaussian_filter1d(amplitude, 16, axis=-1), 0)
    direct = white[:, 0, _BINS]
    direct_power = np.sum(direct**2, axis=1)
    similarity = []
    for cents in _SHIFTS:
        position = _BINS * 2 ** (cents / 1200)
        lower = np.floor(position).astype(int)
        fraction = position - lower
        shifted = white[:, 1, lower] * (1 - fraction) + white[:, 1, lower + 1] * fraction
        normalization = np.sqrt(np.maximum(direct_power * np.sum(shifted**2, axis=1), 1e-20))
        similarity.append(np.sum(direct * shifted, axis=1) / normalization)
    scores = np.asarray(similarity).T
    best = np.argmax(scores, axis=1)
    selected = scores[np.arange(len(scores)), best]
    return np.column_stack((selected, _SHIFTS[best], selected - scores[:, len(_SHIFTS) // 2]))


def _frame_features(frames: NDArray[np.float64]) -> NDArray[np.float64]:
    mid, side = frames[:, 0], frames[:, 1]
    mid_power, side_power = np.mean(mid**2, axis=1), np.mean(side**2, axis=1)
    pan = np.sum(mid * side, axis=1) / np.maximum(np.sum(mid**2, axis=1), 1e-20)
    side = side - pan[:, None] * mid
    residual = np.mean(side**2, axis=1) / np.maximum(side_power, 1e-20)
    spectra = np.fft.rfft(np.stack((mid, side), axis=1) * _WINDOW, n=2 * _SIZE, axis=-1)
    power = np.asarray(abs(spectra) ** 2, dtype=np.float64)
    return np.column_stack(
        (
            10 * np.log10(np.maximum(mid_power, 1e-20)),
            10 * np.log10(np.maximum(side_power, 1e-20) / np.maximum(mid_power, 1e-20)),
            residual,
            _pitch(power[:, 0]),
            _pitch(power[:, 1]),
            _harmonic_match(spectra),
        )
    )


def _read_frames(audio: sf.SoundFile, centers: NDArray[np.int64]) -> NDArray[np.float64]:
    first = int(centers[0]) - round(audio.samplerate * 0.08)
    count = int(centers[-1] - centers[0]) + round(audio.samplerate * 0.16)
    left = max(0, -first)
    audio.seek(max(0, first))
    samples = audio.read(min(count - left, audio.frames - audio.tell()), always_2d=True)
    if not np.isfinite(samples).all():
        raise DependencyError("StudioMasterInvalidAudio", "Audio contains invalid samples")
    samples = np.pad(samples, ((left, count - left - len(samples)), (0, 0)))
    divisor = math.gcd(audio.samplerate, _RATE)
    samples = resample_poly(samples, _RATE // divisor, audio.samplerate // divisor, axis=0)
    needed = _SIZE + (len(centers) - 1) * _HOP
    samples = np.pad(samples, ((0, max(0, needed - len(samples))), (0, 0)))
    mid_side = np.column_stack((samples.mean(axis=1), (samples[:, 0] - samples[:, 1]) / 2))
    return np.lib.stride_tricks.sliding_window_view(mid_side, _SIZE, axis=0)[::_HOP][: len(centers)]


def _measure(reference: Path, cancel: threading.Event) -> _Evidence:
    rows = []
    with sf.SoundFile(reference) as audio:
        centers = np.arange(0, audio.frames, max(1, round(audio.samplerate * 0.04)), dtype=np.int64)
        for start in range(0, len(centers), 32):
            _check_cancel(cancel)
            batch = centers[start : start + 32]
            rows.append(_frame_features(_read_frames(audio, batch)))
        return _Evidence(centers / audio.samplerate, *np.concatenate(rows).T)


def _support(evidence: _Evidence) -> tuple[NDArray[np.bool_], NDArray[np.bool_]]:
    cents = 1200 * np.log2(np.maximum(evidence.side_pitch, 1) / np.maximum(evidence.mid_pitch, 1))
    base = (
        (evidence.mid_db > max(float(np.percentile(evidence.mid_db, 80)) - 25, -100))
        & (evidence.side_db > -30)
        & (evidence.side_db < -3)
        & (evidence.residual > 0.7)
    )
    support = (
        base
        & (abs(cents) < 80)
        & (evidence.mid_confidence > 0.55)
        & (evidence.side_confidence > 0.55)
        & (evidence.similarity > 0.55)
    )
    # An anchor requires a separately detuned harmonic family, not just width,
    # EQ, zero-lag panning, or ordinary harmonic/vibrato recurrence in one voice.
    strong = (
        base
        & (evidence.side_db > -26)
        & (abs(cents) < 60)
        & (evidence.mid_confidence > 0.7)
        & (evidence.side_confidence > 0.7)
        & (evidence.similarity > 0.65)
        & (abs(evidence.detune) >= 5)
        & (evidence.shift_improvement > 0.01)
    )
    return strong, support


def _region(
    evidence: _Evidence, indices: NDArray[np.int64], strong: NDArray[np.bool_], duration: float
) -> tuple[list[VocalLayerRegion], dict[str, object]] | None:
    anchors = indices[strong[indices]]
    start, end = (
        max(0.0, float(evidence.times[indices[0]]) - 0.08),
        min(duration, float(evidence.times[indices[-1]]) + 0.08),
    )
    if (
        len(anchors) < 3
        or end - start < 0.24
        or evidence.times[anchors[-1]] - evidence.times[anchors[0]] < 0.08 - 1e-8
    ):
        return None
    if _late_response(evidence, int(indices[0]), int(indices[-1])):
        return None
    side_db = float(np.median(evidence.side_db[indices]))
    total_gain = min(0.35, 2 * 10 ** (side_db / 20))
    depth = float(np.clip(np.percentile(abs(evidence.detune[anchors]), 75) * 0.1, 1, 4))
    confidence = float(np.clip(np.median(evidence.similarity[anchors]), 0, 1))
    return _double_pair(start, end, total_gain, depth, confidence, side_db), {
        "start": start,
        "end": end,
        "strongFrames": len(anchors),
        "supportedFrames": len(indices),
        "sideToMidDb": side_db,
        "harmonicMatch": confidence,
        "detuneCents": float(np.median(abs(evidence.detune[anchors]))),
    }


def _double_pair(
    start: float, end: float, total_gain: float, depth: float, confidence: float, side_db: float
) -> list[VocalLayerRegion]:
    """Reconstruct an estimated pair; these delays are not measured source timing."""
    return [
        VocalLayerRegion(
            start,
            end,
            "double",
            total_gain / 2,
            delay_ms=delay,
            pan=pan,
            modulation_ms=depth,
            confidence=confidence,
            target_side_to_mid_db=side_db,
        )
        for delay, pan in ((20, -1.0), (27, 1.0))
    ]


def _late_response(evidence: _Evidence, first: int, last: int) -> bool:
    """Keep clearly delayed room/echo envelopes out of the short-double planner."""
    start, end = max(10, first - 10), min(len(evidence.times), last + 11)
    if end - start < 10:
        return False
    mid = 10 ** (evidence.mid_db / 20)
    side = 10 ** ((evidence.mid_db + evidence.side_db) / 20)
    expected = side[start:end] - np.mean(side[start:end])
    scores = []
    for lag in range(11):
        direct = mid[start - lag : end - lag]
        direct = direct - np.mean(direct)
        normalization = max(float(np.linalg.norm(direct) * np.linalg.norm(expected)), 1e-20)
        scores.append(float(np.dot(direct, expected) / normalization))
    best = int(np.argmax(scores))
    short = max(0.0, max(scores[:3]))
    # Require a strong delayed match and a material reduction in the error left
    # by all lags through 80 ms; a broad correlation shoulder is not enough.
    return (
        best >= 3 and scores[best] >= 0.8 and scores[best] ** 2 - short**2 > 0.25 * (1 - short**2)
    )


def _plan(evidence: _Evidence, duration: float) -> tuple[list[VocalLayerRegion], dict[str, object]]:
    strong, support = _support(evidence)
    supported = np.flatnonzero(support)
    regions: list[VocalLayerRegion] = []
    details: list[dict[str, object]] = []
    # Continue across at most 120 ms of uncertain phonetic evidence. Long gaps
    # split regions; unsupported verses cannot inherit another section's layers.
    boundaries = np.flatnonzero(np.diff(supported) > 4) + 1
    for indices in np.split(supported, boundaries):
        if not len(indices):
            continue
        planned = _region(evidence, indices, strong, duration)
        if planned is not None:
            additions, evidence_report = planned
            regions.extend(additions)
            details.append(evidence_report)
    return regions, {
        "frameCount": len(evidence.times),
        "strongFrames": int(strong.sum()),
        "regions": details,
    }


def analyze_doubling(
    reference: Path, cancel: threading.Event
) -> tuple[list[VocalLayerRegion], dict[str, object]]:
    """Return source-coordinate layer regions; exact original delay is not identifiable.

    This recognizes supported near-unison voiced layers and reconstructs a
    restrained short double. Reference PCM is never passed to a renderer.
    """
    _check_cancel(cancel)
    info = sf.info(reference)
    report: dict[str, object] = {
        "applied": False,
        "method": "independent-near-unison-vocal",
        "timingPolicy": "estimated-short-double",
        "analysisRate": _RATE,
    }
    if info.channels != 2 or info.samplerate < _RATE or info.duration < 0.4:
        return [], report
    response, score = measure_stereo_response(reference, _RATE, cancel)
    report["fixedResponseScore"] = score
    if response.size:
        report["reason"] = "fixed-spatial-response-preserved"
        return [], report
    regions, evidence = _plan(_measure(reference, cancel), info.duration)
    report.update(evidence)
    report["applied"] = bool(regions)
    return regions, report
