"""Check that melodic improvement does not introduce sustained vocal roughness."""

from pathlib import Path
import math
import threading

import numpy as np
from numpy.typing import NDArray
import soundfile as sf
from scipy.signal import resample_poly

from backend.domain_errors import DependencyError
from backend.recordings.studio_audio import _check_cancel

_RATE, _SIZE, _HOP = 16000, 1280, 640
_WINDOW = np.hanning(_SIZE)
_WINDOW_CORRELATION = np.fft.irfft(abs(np.fft.rfft(_WINDOW, 2 * _SIZE)) ** 2)[:501]
_PERIOD_RATIOS = 2 ** (np.arange(-50, 50.1, 2.5) / 1200)
_MAX_PERIODICITY_LOSS = 0.08
_MAX_DEGRADED_FRACTION = 0.1


def _read_frames(audio: sf.SoundFile, centers: NDArray[np.float64]) -> NDArray[np.float64]:
    start = max(0, round((centers[0] - 0.04) * audio.samplerate))
    end = min(audio.frames, round((centers[-1] + 0.04) * audio.samplerate))
    audio.seek(start)
    samples = audio.read(end - start, always_2d=True)
    if not np.isfinite(samples).all():
        raise DependencyError("StudioMasterInvalidAudio", "Audio contains invalid samples")
    divisor = math.gcd(audio.samplerate, _RATE)
    samples = resample_poly(samples, _RATE // divisor, audio.samplerate // divisor, axis=0)
    required = _SIZE + (len(centers) - 1) * _HOP
    samples = np.pad(samples, ((0, max(0, required - len(samples))), (0, 0)))
    frames = np.lib.stride_tricks.sliding_window_view(samples, _SIZE, axis=0)[::_HOP]
    return np.asarray(np.moveaxis(frames[: len(centers)], -1, 1), dtype=np.float64)


def _remove_pitch_motion(
    frames: NDArray[np.float64],
    centers: NDArray[np.float64],
    times: NDArray[np.float64],
    notes: NDArray[np.float64],
) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    positions = centers[:, None] + np.arange(_SIZE)[None, :] / _RATE - 0.04
    frequencies = 440 * 2 ** ((np.interp(positions, times, notes) - 69) / 12)
    phases = np.cumsum(frequencies, axis=1)
    aligned = np.empty_like(frames)
    # Remove measured vibrato only in the analysis copy. The candidate PCM is
    # never rewritten, and phase is never inferred from the reference singer.
    for index, phase in enumerate(phases):
        uniform = np.linspace(phase[0], phase[-1], _SIZE)
        for channel in range(frames.shape[2]):
            aligned[index, :, channel] = np.interp(uniform, phase, frames[index, :, channel])
    return aligned, np.asarray(np.mean(frequencies, axis=1), dtype=np.float64)


def _periodicity(
    frames: NDArray[np.float64], frequencies: NDArray[np.float64]
) -> NDArray[np.float64]:
    spectra = np.fft.rfft(frames * _WINDOW[None, :, None], n=2 * _SIZE, axis=1)
    power = np.mean(abs(spectra) ** 2, axis=2)
    correlation = np.fft.irfft(power, n=2 * _SIZE, axis=1)[:, :501]
    correlation /= np.maximum(correlation[:, :1], 1e-20)
    correlation *= _WINDOW_CORRELATION[0] / _WINDOW_CORRELATION
    result = np.zeros(len(frames))
    for index, (row, frequency) in enumerate(zip(correlation, frequencies)):
        # Several cycles expose rough sidebands that still repeat almost exactly
        # over one high-pitched cycle. The 25 ms span also bounds vibrato residuals.
        periods = _RATE / frequency * _PERIOD_RATIOS
        cycles = np.arange(1, max(2, math.floor(0.025 * frequency) + 1))
        positions = periods[:, None] * cycles[None, :]
        nearest = np.rint(positions).astype(int)
        fraction = positions - nearest
        values = row[nearest] + 0.5 * fraction * (row[nearest + 1] - row[nearest - 1])
        values += 0.5 * fraction**2 * (row[nearest + 1] + row[nearest - 1] - 2 * row[nearest])
        result[index] = np.clip(np.max(np.mean(values, axis=1)), 0, 1)
    return result


def _measure(
    source: sf.SoundFile,
    candidate: sf.SoundFile,
    centers: NDArray[np.float64],
    selected: NDArray[np.bool_],
    times: NDArray[np.float64],
    notes: tuple[NDArray[np.float64], NDArray[np.float64]],
    cancel: threading.Event,
) -> NDArray[np.float64]:
    rows = []
    for first in range(0, len(centers), 32):
        _check_cancel(cancel)
        batch, active = centers[first : first + 32], selected[first : first + 32]
        if not active.any():
            continue
        scores = []
        for audio, curve in zip((source, candidate), notes):
            frames = _read_frames(audio, batch)[active]
            _check_cancel(cancel)
            aligned, frequency = _remove_pitch_motion(frames, batch[active], times, curve)
            scores.append(_periodicity(aligned, frequency))
        rows.append(np.column_stack(scores))
    return np.concatenate(rows) if rows else np.empty((0, 2))


def _selected_windows(
    centers: NDArray[np.float64],
    times: NDArray[np.float64],
    notes: tuple[NDArray[np.float64], NDArray[np.float64]],
    corrected: NDArray[np.bool_],
) -> NDArray[np.bool_]:
    eligible = corrected.copy()
    for curve in notes:
        frequencies = 440 * 2 ** ((curve - 69) / 12)
        eligible &= np.isfinite(frequencies) & (frequencies >= 40) & (frequencies <= 2000)
    probes = centers[:, None] + np.linspace(-0.04, 0.04, 9)[None, :]
    return np.min(np.interp(probes, times, eligible.astype(float), left=0, right=0), axis=1) > 0.99


def _report(values: NDArray[np.float64]) -> dict[str, object]:
    report: dict[str, object] = {
        "accepted": False,
        "method": "pitch-synchronous-multicycle-coherence",
        "windowMs": 80,
        "comparedSeconds": len(values) * _HOP / _RATE,
        "maximumPeriodicityLoss": _MAX_PERIODICITY_LOSS,
        "maximumDegradedFraction": _MAX_DEGRADED_FRACTION,
    }
    if len(values) < 3:
        return {**report, "reason": "insufficient-corrected-voiced-audio"}
    loss = values[:, 0] - values[:, 1]
    degraded = float(np.mean(loss > _MAX_PERIODICITY_LOSS))
    report.update(
        accepted=degraded <= _MAX_DEGRADED_FRACTION,
        degradedFraction=degraded,
        p90PeriodicityLoss=float(np.percentile(np.maximum(loss, 0), 90)),
        sourceMedianPeriodicity=float(np.median(values[:, 0])),
        candidateMedianPeriodicity=float(np.median(values[:, 1])),
    )
    return report


def inspect_pitch_timbre(
    source: Path,
    candidate: Path,
    times: NDArray[np.float64],
    voice_notes: NDArray[np.float64],
    candidate_notes: NDArray[np.float64],
    corrected: NDArray[np.bool_],
    cancel: threading.Event,
) -> dict[str, object]:
    """Compare a candidate against its own source using already measured pitch.

    This is a conservative veto for newly nonperiodic voiced audio, not a model
    of subjective timbre or a requirement that naturally breathy voices be pure.
    """
    _check_cancel(cancel)
    with sf.SoundFile(source) as dry, sf.SoundFile(candidate) as wet:
        if (dry.frames, dry.samplerate, dry.channels) != (wet.frames, wet.samplerate, wet.channels):
            return {"accepted": False, "reason": "changed-audio-format"}
        centers = np.arange(0.04, dry.frames / dry.samplerate - 0.04 + 1e-9, 0.04)
        notes = voice_notes, candidate_notes
        selected = _selected_windows(centers, times, notes, corrected)
        values = _measure(dry, wet, centers, selected, times, notes, cancel)
    _check_cancel(cancel)
    return _report(values)
