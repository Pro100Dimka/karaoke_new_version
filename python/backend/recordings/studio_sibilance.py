"""Conservative, linked-channel control of exceptional noisy vocal high frequencies."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import threading

import numpy as np
from numpy.typing import NDArray
import soundfile as sf
from scipy.ndimage import maximum_filter1d, uniform_filter1d
from scipy.signal import fftconvolve, find_peaks, firwin
from scipy.fft import irfft, rfft, rfftfreq

from backend.domain_errors import DependencyError
from backend.recordings.studio_audio import _check_cancel, _temporary_wave

_LOW_HZ = 4000.0
_HIGH_HZ = 11000.0
_MAX_REDUCTION_DB = 6.0
_BLOCK_FRAMES = 65536


@dataclass(frozen=True, slots=True)
class _Evidence:
    times: NDArray[np.float64]
    body: NDArray[np.float64]
    high: NDArray[np.float64]
    flatness: NDArray[np.float64]
    recurrence: NDArray[np.float64]


def _read_context(audio: sf.SoundFile, start: int, count: int) -> NDArray[np.float64]:
    """Read a bounded range, keeping the recording's original sample positions."""
    left = max(0, -start)
    audio.seek(max(0, start))
    samples = audio.read(min(count - left, audio.frames - max(0, start)), always_2d=True)
    if not np.isfinite(samples).all():
        raise DependencyError("StudioMasterInvalidAudio", "Audio contains invalid samples")
    return np.pad(samples, ((left, count - left - len(samples)), (0, 0)))


def _envelope_peaks(correlation: NDArray[np.float64], first_lag: int) -> NDArray[np.float64]:
    confidence = np.zeros(len(correlation))
    for index, row in enumerate(correlation):
        peaks = find_peaks(row)[0]
        peaks = peaks[peaks >= first_lag]
        # A noisy consonant's smooth onset creates a zero-lag shoulder. Require
        # an actual repeat after a trough, not similarity to that broad shoulder.
        peaks = peaks[np.minimum.accumulate(row)[peaks] <= 0]
        if len(peaks):
            confidence[index] = float(np.max(row[peaks]))
    return confidence


def _envelope_features(
    frames: NDArray[np.float64], rate: int, high: NDArray[np.bool_], window: NDArray[np.float64]
) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    size = frames.shape[-1]
    spectrum = rfft(frames, n=size * 2, axis=-1)
    band = irfft(spectrum * high, n=size * 2, axis=-1)[..., :size]
    local = slice(size // 2 - round(rate * 0.01), size // 2 + round(rate * 0.01))
    # Long windows classify the sound; local power keeps gain changes at the
    # consonant itself instead of anticipating a future bright harmonic attack.
    power = np.mean(band[..., local] ** 2, axis=(1, 2))
    envelope = uniform_filter1d(
        np.mean(band**2, axis=1), size=round(rate * 0.001), axis=-1, mode="nearest"
    )
    envelope -= (np.sum(envelope * window, axis=-1) / np.sum(window))[:, None]
    correlation = irfft(abs(rfft(envelope * window, size * 2)) ** 2)
    window_correlation = irfft(abs(rfft(window, size * 2)) ** 2)
    last_lag = round(rate * 0.03)
    correlation = correlation[:, :last_lag] / np.maximum(correlation[:, :1], 1e-30)
    correlation *= window_correlation[0] / window_correlation[:last_lag]
    # Vibrato can decorrelate the HF carrier while its harmonic energy pattern
    # still repeats. This guard uses only HF evidence, not a voiced-body veto.
    return power, _envelope_peaks(correlation, round(rate * 0.002))


def _frame_features(frames: NDArray[np.float64], rate: int) -> NDArray[np.float64]:
    size = frames.shape[-1]
    window = np.hanning(size)
    spectrum = rfft(frames * window, n=size * 2, axis=-1)
    # Powers, rather than a mono sum, also work with antiphase stereo recordings.
    power = np.mean(abs(spectrum) ** 2, axis=1)
    frequency = rfftfreq(size * 2, 1 / rate)
    body = (frequency >= 300) & (frequency < 3500)
    high = (frequency >= _LOW_HZ) & (frequency <= min(_HIGH_HZ, rate * 0.45))
    local_high, envelope_recurrence = _envelope_features(frames, rate, high, window)
    band = power[:, high]
    flatness = np.exp(np.mean(np.log(np.maximum(band, 1e-30)), axis=1))
    flatness /= np.maximum(np.mean(band, axis=1), 1e-30)
    correlation = irfft(power * high, n=size * 2, axis=-1)
    window_correlation = irfft(abs(rfft(window, size * 2)) ** 2)
    lag = slice(round(rate * 0.002), round(rate * 0.03))
    # Remove the window's lag-dependent loss before assessing harmonic recurrence.
    recurrence = correlation[:, lag] / np.maximum(correlation[:, :1], 1e-30)
    recurrence *= window_correlation[0] / window_correlation[lag]
    normalization = 1 / (size * np.sum(window**2))
    return np.column_stack(
        (
            np.sum(power[:, body], axis=1) * normalization,
            local_high,
            flatness,
            np.maximum(np.max(recurrence, axis=1), envelope_recurrence),
        )
    )


def _measure(source: Path, cancel: threading.Event) -> _Evidence:
    with sf.SoundFile(source) as audio:
        # Enough evidence for bass harmonics; decisions still update every 10 ms.
        hop, size = round(audio.samplerate * 0.01), round(audio.samplerate * 0.08)
        centers = np.arange(0, audio.frames, hop)
        features = np.empty((len(centers), 4))
        for start in range(0, len(centers), 32):
            _check_cancel(cancel)
            batch = centers[start : start + 32]
            count = int(batch[-1] - batch[0]) + size
            samples = _read_context(audio, int(batch[0]) - size // 2, count)
            frames = np.lib.stride_tricks.sliding_window_view(samples, size, axis=0)[::hop]
            features[start : start + len(batch)] = _frame_features(frames, audio.samplerate)
        return _Evidence(centers / audio.samplerate, *features.T)


def _smooth(reduction: NDArray[np.float64], hop_seconds: float) -> NDArray[np.float64]:
    envelope = np.empty_like(reduction)
    previous = 0.0
    attack, release = np.exp(-hop_seconds / np.array([0.005, 0.06]))
    for index, desired in enumerate(reduction):
        coefficient = attack if desired > previous else release
        previous = float(desired + coefficient * (previous - desired))
        envelope[index] = previous if previous >= 0.01 else 0.0
    return envelope


def _plan(evidence: _Evidence) -> NDArray[np.float64]:
    body_db = 10 * np.log10(np.maximum(evidence.body, 1e-30))
    high_db = 10 * np.log10(np.maximum(evidence.high, 1e-30))
    active = body_db > max(float(np.max(body_db)) - 30, -100)
    if np.count_nonzero(active) < 20:
        return np.zeros(len(body_db))
    # Two relative tests: near the normal vocal body, and exceptional for this
    # recording. Quiet consonants/breaths and steady bright voices stay untouched.
    threshold = max(
        float(np.quantile(body_db[active], 0.75)) - 2, float(np.median(high_db[active])) + 6
    )
    # A window overlapping a harmonic attack can look like noise before enough
    # periods arrive. Protect its neighboring half-window when the HF itself is
    # confidently periodic; tiny harmonic leakage from ordinary vowels cannot veto.
    harmonic = (evidence.recurrence >= 0.8) & (high_db >= threshold - 6)
    harmonic = maximum_filter1d(harmonic, size=9, mode="constant")
    noise = (evidence.flatness >= 0.15) & ~harmonic
    eligible = noise & (high_db > body_db - 3)
    desired = np.where(eligible, np.clip((high_db - threshold) * 0.75, 0, 6), 0)
    return _smooth(desired, float(evidence.times[1] - evidence.times[0]))


def _render(
    source: Path,
    target: Path,
    times: NDArray[np.float64],
    reduction: NDArray[np.float64],
    cancel: threading.Event,
) -> None:
    with sf.SoundFile(source) as audio:
        # Centered, linear-phase FIR: subtract only the selected band, with no
        # residual crossover phase shift or added latency in the dry recording.
        taps = int(round(audio.samplerate * 0.006)) | 1
        kernel = firwin(
            taps,
            [_LOW_HZ, min(_HIGH_HZ, audio.samplerate * 0.45)],
            pass_zero=False,
            fs=audio.samplerate,
            window=("kaiser", 8),
        )
        half = taps // 2
        with _temporary_wave(target, samplerate=audio.samplerate, channels=audio.channels) as out:
            for offset in range(0, audio.frames, _BLOCK_FRAMES):
                _check_cancel(cancel)
                count = min(_BLOCK_FRAMES, audio.frames - offset)
                context = _read_context(audio, offset - half, count + 2 * half)
                band = fftconvolve(context, kernel[:, None], mode="valid", axes=0)
                positions = (offset + np.arange(count)) / audio.samplerate
                gain = 10 ** (-np.interp(positions, times, reduction) / 20)
                original = context[half : half + count]
                out.write(original + (gain[:, None] - 1) * band)


def apply_sibilance_control(
    source: Path, target: Path, cancel: threading.Event
) -> tuple[Path, dict[str, object]]:
    """Attenuate supported sibilant bursts; bypass without rewriting other voices."""
    _check_cancel(cancel)
    info = sf.info(source)
    report: dict[str, object] = {
        "applied": False,
        "method": "adaptive-linked-split-band",
        "affectedSeconds": 0.0,
        "maxReductionDb": 0.0,
        "bandLowHz": _LOW_HZ,
        "bandHighHz": min(_HIGH_HZ, info.samplerate * 0.45),
        "limitDb": _MAX_REDUCTION_DB,
    }
    if info.samplerate < 16000 or info.duration < 0.2:
        return source, report
    evidence = _measure(source, cancel)
    reduction = _plan(evidence)
    if float(np.max(reduction)) < 0.1:
        return source, report
    _render(source, target, evidence.times, reduction, cancel)
    report.update(
        applied=True,
        affectedSeconds=float(
            np.count_nonzero(reduction >= 0.1) * (evidence.times[1] - evidence.times[0])
        ),
        maxReductionDb=float(np.max(reduction)),
    )
    return target, report
