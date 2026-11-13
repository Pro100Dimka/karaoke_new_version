from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
import math
import threading
import numpy as np
import soundfile as sf
from scipy.ndimage import median_filter
from scipy.optimize import nnls
from scipy.signal import butter, find_peaks, resample_poly, sosfilt
from backend.recordings.studio_audio import _check_cancel, _temporary_wave
from backend.domain_errors import DependencyError


@dataclass(frozen=True, slots=True)
class StereoField:
    ratio: float = 0.0
    lag: float = 0.0
    spread: float = 0.0
    low_hz: float = 0.0
    support: int = 0
    tail_seconds: float = 0.0
    tail_gain: float = 0.0


@dataclass(frozen=True, slots=True)
class SpaceProfile:
    delay_seconds: float = 0
    delay_gain: float = 0
    delay_support: float = 0
    decay_seconds: float = 0
    reverb_gain: float = 0
    decay_count: int = 0
    stereo_width: float = 0.0
    effect_type: str = "none"
    echo_taps: tuple[tuple[float, float], ...] = ()
    echo_regions: tuple[tuple[float, float, float], ...] = ()
    duration: float = 0.0
    tail_band_hz: tuple[float, float] = (0.0, 0.0)
    field: StereoField = StereoField()


def _reference_width(path: Path, cancel: threading.Event) -> float:
    """Robust stereo difference ratio from active blocks, bounded to [0, 1].

    Width alone cannot prove the presence or settings of a reverb. It is used
    only to shape a tail after temporal evidence establishes its presence.
    """
    values: list[float] = []
    with sf.SoundFile(path) as source:
        if source.channels < 2:
            return 0.0
        for samples in source.blocks(blocksize=source.samplerate, dtype="float32", always_2d=True):
            _check_cancel(cancel)
            left, right = samples[:, 0], samples[:, 1]
            power = float(np.mean(left * left + right * right))
            if power > 1e-7:
                difference = float(np.mean((left - right) ** 2))
                values.append(float(np.clip(difference / power, 0, 1)))
    return float(np.median(values)) if values else 0.0


def analyze_space(path: Path, cancel: threading.Event) -> SpaceProfile:
    levels, cepstra, positions = _read_evidence(path, cancel)
    delay, gain, support = _delay(cepstra)
    taps = _echo_taps(cepstra)
    decay, wet, count = _decay(levels)
    width = _reference_width(path, cancel)
    kind = ("slapback" if delay < 0.12 else "delay") if gain else "none"
    return SpaceProfile(
        delay,
        gain,
        support,
        decay,
        wet,
        count,
        width,
        kind,
        taps,
        _echo_regions(cepstra, positions, taps),
        sf.info(path).duration,
        _tail_band(path, levels, cancel) if wet else (0.0, 0.0),
        _stereo_field(path, cancel) if width > 0.05 else StereoField(),
    )


def _missing_taps(
    reference: SpaceProfile, existing: SpaceProfile
) -> tuple[tuple[float, float], ...]:
    taps = tuple(
        (
            delay,
            max(
                0.0,
                gain
                - max(
                    (
                        other_gain
                        for other_delay, other_gain in existing.echo_taps
                        if abs(delay - other_delay) <= max(0.012, 0.08 * delay)
                    ),
                    default=0.0,
                ),
            ),
        )
        for delay, gain in reference.echo_taps
    )
    return taps


def match_space(reference: SpaceProfile, existing: SpaceProfile) -> SpaceProfile:
    # Existing recorded tails cannot be shortened by adding another effect.
    decay = reference.decay_seconds or reference.field.tail_seconds
    strength = reference.reverb_gain or reference.field.tail_gain
    reverb = (
        math.sqrt(max(0, strength**2 - existing.reverb_gain**2))
        if existing.decay_seconds <= decay
        else 0.0
    )
    # Subtract existing echo only when it is the *same* measured repeat.
    # Previously an unrelated short reflection could cancel the reference
    # delay entirely, leaving the mastered vocal without the desired echo.
    same_delay = (
        reference.delay_gain > 0
        and existing.delay_gain > 0
        and abs(reference.delay_seconds - existing.delay_seconds)
        <= max(0.012, 0.08 * reference.delay_seconds)
    )
    existing_echo_gain = existing.delay_gain if same_delay else 0.0
    taps = _missing_taps(reference, existing)
    return SpaceProfile(
        delay_seconds=reference.delay_seconds,
        delay_gain=float(np.clip(reference.delay_gain - existing_echo_gain, 0, 0.35)),
        delay_support=reference.delay_support,
        decay_seconds=decay,
        reverb_gain=float(np.clip(reverb, 0, 0.35)),
        decay_count=reference.decay_count,
        stereo_width=reference.stereo_width,
        effect_type=reference.effect_type,
        echo_taps=tuple((delay, gain) for delay, gain in taps if gain > 0.001),
        echo_regions=reference.echo_regions,
        duration=reference.duration,
        tail_band_hz=reference.tail_band_hz
        if reference.reverb_gain
        else (reference.field.low_hz, 3500.0),
        field=_missing_field(reference, existing),
    )


def _missing_field(reference: SpaceProfile, existing: SpaceProfile) -> StereoField:
    field = reference.field
    if not field.lag:
        return StereoField()
    # Reserve energy for tails and echoes before filling the remaining stereo field.
    tail = max(reference.reverb_gain, field.tail_gain)
    ratio = max(0.0, field.ratio - tail**2 - reference.delay_gain**2 - existing.field.ratio)
    if ratio < 0.05:
        return StereoField()
    return StereoField(ratio, field.lag, field.spread, field.low_hz, field.support)


def _field_envelopes(path: Path, cancel: threading.Event) -> np.ndarray:
    rows = []
    with sf.SoundFile(path) as source:
        if source.channels < 2 or source.samplerate <= 7000:
            return np.empty((0, 2, 2))
        step = max(1, round(source.samplerate * 0.02))
        bands = [
            butter(2, edges, fs=source.samplerate, btype="bandpass", output="sos")
            for edges in ((150, 500), (500, 3500))
        ]
        states = [np.zeros((len(band), 2, 2)) for band in bands]
        for block in source.blocks(blocksize=step * 150, always_2d=True):
            _check_cancel(cancel)
            count = len(block) // step
            if not count:
                continue
            powers = []
            for index, band in enumerate(bands):
                samples, states[index] = sosfilt(band, block[:, :2], axis=0, zi=states[index])
                mid_side = np.column_stack(
                    (samples.mean(axis=1), np.diff(samples, axis=1)[:, 0] / 2)
                )
                powers.append(
                    np.mean(mid_side[: count * step].reshape(count, step, 2) ** 2, axis=1)
                )
            rows.append(np.stack(powers, axis=1))
    return np.concatenate(rows) if rows else np.empty((0, 2, 2))


def _field_lags(envelopes: np.ndarray) -> list[float]:
    fits = []
    floor = max(1e-10, float(np.percentile(envelopes[:, 0], 80)) * 0.15)
    for start in range(0, len(envelopes) - 149, 150):
        section = envelopes[start : start + 150]
        if np.count_nonzero(section[:, 0] > floor) < 30:
            continue
        mid, side = np.sqrt(section).T
        if min(float(np.std(mid)), float(np.std(side))) < 1e-8:
            continue
        scores = np.array([np.corrcoef(mid[: 150 - lag], side[lag:])[0, 1] for lag in range(9)])
        if not np.isfinite(scores).all():
            continue
        best = int(np.argmax(scores))
        if 0 < best < 8 and scores[best] >= 0.6 and scores[best] - scores[0] > 0.015:
            fits.append(best * 0.02)
    return fits


def _stereo_field(path: Path, cancel: threading.Event) -> StereoField:
    """Measure delayed stereo energy, without identifying a production effect."""
    envelopes = _field_envelopes(path, cancel)
    if len(envelopes) < 450:
        return StereoField()
    active = envelopes[:, 1, 0] > max(1e-10, float(np.percentile(envelopes[:, 1, 0], 80)) * 0.15)
    power = envelopes[active].sum(axis=0)
    ratios = power[:, 1] / np.maximum(power[:, 0], 1e-20)
    ratio = float(np.clip(ratios[1], 0, 0.65))
    fits = _field_lags(envelopes[:, 1])
    if ratio < 0.1 or len(fits) < 3:
        return StereoField(ratio=ratio)
    lag = float(np.median(fits))
    consistent = np.abs(np.asarray(fits) - lag) <= 0.04
    if np.count_nonzero(consistent) < max(3, len(fits) * 0.6):
        return StereoField(ratio=ratio)
    spread = float(np.clip(np.std(np.asarray(fits)[consistent]), 0.002, lag * 0.25))
    low = float(np.clip(300 * max(0, ratios[1] / max(ratios[0], 1e-8) - 1) ** 0.25, 150, 1200))
    decay, wet = _field_tail(envelopes[:, 1])
    return StereoField(ratio, lag, spread, low, int(np.count_nonzero(consistent)), decay, wet)


def _field_tail(envelopes: np.ndarray) -> tuple[float, float]:
    """Estimate a diffuse response, not an identified reverb, from stereo energy."""
    scale = max(float(np.percentile(envelopes[:, 0], 85)), 1e-10)
    mid, side = (envelopes / scale).T
    windows = np.lib.stride_tricks.sliding_window_view(np.pad(mid, (30, 0)), 31)[:, ::-1]
    partition = (np.arange(len(mid)) // 150) % 2 == 0
    improvements = []
    kernels = []
    for training in (partition, ~partition):
        try:
            kernel, _ = nnls(windows[training], side[training])
            short, _ = nnls(windows[training, :7], side[training])
        except RuntimeError:
            return 0.0, 0.0
        full_error = float(np.mean((windows[~training] @ kernel - side[~training]) ** 2))
        short_error = float(np.mean((windows[~training, :7] @ short - side[~training]) ** 2))
        improvements.append(1 - full_error / max(short_error, 1e-20))
        kernels.append(kernel)
    if min(improvements) < 0.05 or np.mean(improvements) < 0.1:
        return 0.0, 0.0
    kernel = np.mean(kernels, axis=0)
    late = float(np.sum(kernel[7:]))
    if late < 0.05 or late < np.sum(kernel) * 0.2:
        return 0.0, 0.0
    # Convert the late energy's mean excess delay to an exponential-decay proxy.
    mean_delay = float(np.average(np.arange(7, 31) * 0.02 - 0.14, weights=kernel[7:]))
    return float(np.clip(13.8155 * mean_delay, 0.3, 2.5)), min(0.35, math.sqrt(late))


def write_impulse(profile: SpaceProfile, path: Path, rate: int, channels: int) -> None:
    taps = profile.echo_taps or ((profile.delay_seconds, profile.delay_gain),)
    length = round((max(profile.decay_seconds, max(t[0] for t in taps), 0.02) + 0.02) * rate)
    impulse = np.zeros((length, channels), dtype=np.float64)
    # The dry voice is mixed separately at unity. An impulse at t=0
    # would add a second, unprocessed copy and obscure the wet/dry balance.
    for delay, gain in taps:
        delay_index = round(delay * rate)
        if 0 < delay_index < length:
            impulse[delay_index] += gain
    if profile.reverb_gain and profile.decay_seconds > 0:
        start = 1  # No zero-lag dry copy in a wet-only impulse; not a musical predelay.
        time = np.arange(length - start) / rate
        noise = np.random.default_rng(0).normal(size=(len(time), channels))
        low, high = profile.tail_band_hz
        if 0 < low < high < rate / 2:
            band = butter(2, [low, high], btype="bandpass", fs=rate, output="sos")
            noise = sosfilt(band, noise, axis=0)
        width = np.clip(profile.stereo_width, 0, 1)
        if channels >= 2:
            noise = np.sqrt(1 - width) * noise[:, :1] + np.sqrt(width) * noise
        tail = noise * np.exp(-6.9078 * time[:, None] / profile.decay_seconds)
        tail /= np.maximum(np.linalg.norm(tail, axis=0), 1e-12)
        impulse[start:] += profile.reverb_gain * tail
    with _temporary_wave(path, samplerate=rate, channels=channels) as output:
        output.write(impulse)


def _read_evidence(
    path: Path, cancel: threading.Event, *, include_cepstra: bool = True
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Measure loudness continuously and echo evidence in overlapping windows.

    Overlap avoids losing a repeat whenever its onset crosses a window edge.
    Windows are spread across the full reference, not just its beginning.
    """
    levels: list[float] = []
    cepstra: list[np.ndarray] = []
    energies: list[float] = []
    with sf.SoundFile(path) as source:
        rate = source.samplerate
        block = rate * 2
        step = max(1, round(rate * 0.02))
        # Preserve the original continuous loudness measurement.
        for samples in source.blocks(blocksize=block, always_2d=True):
            _check_cancel(cancel)
            if not np.isfinite(samples).all():
                raise DependencyError("StudioMasterInvalidAudio", "Audio contains invalid samples")
            samples = samples[:, :2]
            usable = len(samples) // step * step
            if usable:
                power = np.mean(
                    samples[:usable].reshape(-1, step, samples.shape[1]) ** 2,
                    axis=(1, 2),
                )
                levels.extend(10 * np.log10(np.maximum(power, 1e-12)))
        if source.frames < block or not include_cepstra:
            return np.asarray(levels), np.empty((0, 8193)), np.empty(0)
        energies, cepstra, positions = _sample_cepstra(source, cancel)
    if not energies:
        return np.asarray(levels), np.empty((0, 8193)), np.empty(0)
    active = np.asarray(energies) > max(1e-8, float(np.percentile(energies, 75)) * 0.25)
    return np.asarray(levels), np.asarray(cepstra)[active], positions[active]


def _sample_cepstra(
    source: sf.SoundFile, cancel: threading.Event
) -> tuple[list[float], list[np.ndarray], np.ndarray]:
    energies: list[float] = []
    cepstra: list[np.ndarray] = []
    rate, block = source.samplerate, source.samplerate * 2
    # One-second hops give independent placements of the same vocal phrase
    # inside the two-second analysis window. Limit cost on long songs.
    positions = np.arange(0, source.frames - block + 1, rate, dtype=np.int64)
    if len(positions) > 128:
        positions = positions[np.linspace(0, len(positions) - 1, 128).astype(int)]
    previous = np.empty((0, min(source.channels, 2)), dtype="float32")
    for position in positions:
        _check_cancel(cancel)
        if len(previous) == block and source.tell() == position + rate:
            tail = source.read(rate, dtype="float32", always_2d=True)[:, :2]
            samples = np.concatenate((previous[rate:], tail))
        else:
            source.seek(int(position))
            samples = source.read(block, dtype="float32", always_2d=True)[:, :2]
        if len(samples) != block:
            continue
        previous = samples
        energy = float(np.mean(samples.astype(np.float64) ** 2))
        energies.append(energy)
        cepstra.append(_cepstrum(samples, rate))
    return energies, cepstra, positions / rate


def _cepstrum(samples: np.ndarray, rate: int) -> np.ndarray:
    divisor = math.gcd(rate, 8000)
    audio = resample_poly(samples, 8000 // divisor, rate // divisor, axis=0)
    # A tapered window changes the direct/echo ratio at different delays.
    # Use untapered blocks and require the peak to persist across independent blocks.
    spectrum = np.abs(np.fft.rfft(audio, n=16384, axis=0))
    logarithm = np.log(np.maximum(spectrum, np.max(spectrum) * 1e-8 + 1e-12))
    return np.mean(np.fft.irfft(logarithm, n=16384, axis=0), axis=1)[:8193]


def _delay(cepstra: np.ndarray) -> tuple[float, float, float]:
    taps = _echo_taps(cepstra)
    if not taps:
        return 0, 0, 0
    delay, gain = max(taps, key=lambda tap: tap[1])
    support = float(np.mean(cepstra[:, round(delay * 8000)] > 0.01))
    return delay, gain, support


def _echo_taps(cepstra: np.ndarray) -> tuple[tuple[float, float], ...]:
    if len(cepstra) < 6:
        return ()
    # Persistent long-quefrency peaks indicate a delayed copy, not vocal pitch.
    curve = np.percentile(cepstra, 75, axis=0)
    # 40–600 ms: include short slapback while excluding the voiced pitch region.
    lower, upper = 320, 4800
    noise = float(np.median(np.abs(curve[lower:upper])))
    peaks, _ = find_peaks(curve[lower:upper], height=max(0.015, noise * 10), distance=80)
    taps = []
    for peak in peaks[np.argsort(curve[lower:upper][peaks])[-4:]]:
        index = int(peak + lower)
        agreeing = cepstra[:, index] > max(0.01, noise * 6)
        if np.count_nonzero(agreeing) < max(3, len(cepstra) * 0.25):
            continue
        gain = float(np.clip(2 * np.percentile(cepstra[agreeing, index], 75), 0, 0.35))
        taps.append((index / 8000, gain))
    return tuple(sorted(taps))


def _echo_regions(
    cepstra: np.ndarray, positions: np.ndarray, taps: tuple[tuple[float, float], ...]
) -> tuple[tuple[float, float, float], ...]:
    regions: list[tuple[float, float, float]] = []
    for delay, _ in taps:
        supported = cepstra[:, round(delay * 8000)] > 0.01
        if np.mean(supported) >= 0.7:
            continue
        intervals: list[tuple[float, float]] = []
        for position in positions[supported]:
            start, end = float(position), float(position + 2)
            if intervals and start <= intervals[-1][1]:
                intervals[-1] = (intervals[-1][0], end)
            else:
                intervals.append((start, end))
        regions.extend((delay, start, end) for start, end in intervals)
    return tuple(regions)


def _decay(levels: np.ndarray) -> tuple[float, float, int]:
    if len(levels) < 150 or np.percentile(levels, 80) - np.percentile(levels, 10) < 15:
        return 0, 0, 0
    smooth = median_filter(levels, size=3)
    floor = max(-85.0, float(np.percentile(smooth, 10)) + 6)
    # A diffuse tail can emerge gradually after the direct voice releases.
    # Keep abrupt releases and also examine falls across a vocal-release window.
    candidates = np.union1d(
        np.flatnonzero(smooth[:-2] - smooth[2:] > 5) + 2,
        np.flatnonzero(smooth[:-4] - smooth[4:] > 6) + 4,
    )
    evidence = []
    previous = -50
    for index in candidates:
        if index < 12 or index - previous < 50:
            continue
        fit = _fit_decay(smooth, int(index), floor)
        if fit is not None:
            evidence.append(fit)
            previous = int(index)
    if len(evidence) < 3:
        return 0, 0, len(evidence)
    decays, gains = np.asarray(evidence).T
    consistent = np.abs(np.log(decays / np.median(decays))) < 0.4
    if np.count_nonzero(consistent) < 3:
        return 0, 0, len(evidence)
    return float(np.median(decays[consistent])), float(np.median(gains[consistent])), len(evidence)


def _fit_decay(levels: np.ndarray, index: int, floor: float) -> tuple[float, float] | None:
    tail = levels[index : index + 60]
    stops = np.flatnonzero((tail < floor) | (tail > tail[0] + 3))
    if len(stops):
        tail = tail[: stops[0]]
    if len(tail) < 7 or tail[0] - tail[-1] < 10:
        return None
    time = np.arange(len(tail)) * 0.02
    slope, intercept = np.polyfit(time, tail, 1)
    fitted = intercept + slope * time
    error = float(np.sum((tail - fitted) ** 2) / max(1e-12, np.sum((tail - np.mean(tail)) ** 2)))
    if error > 0.15 or not -300 <= slope <= -25:
        return None
    active = float(np.median(levels[index - 12 : index - 2]))
    strength = float(np.clip(10 ** ((intercept - active) / 20), 0, 0.5))
    return float(-60 / slope), strength


def _tail_band(path: Path, levels: np.ndarray, cancel: threading.Event) -> tuple[float, float]:
    smooth = median_filter(levels, size=3)
    floor = max(-85.0, float(np.percentile(smooth, 10)) + 6)
    candidates = np.union1d(
        np.flatnonzero(smooth[:-2] - smooth[2:] > 5) + 2,
        np.flatnonzero(smooth[:-4] - smooth[4:] > 6) + 4,
    )
    bands = []
    with sf.SoundFile(path) as source:
        for index in candidates:
            _check_cancel(cancel)
            if index < 12 or _fit_decay(smooth, int(index), floor) is None:
                continue
            source.seek(min(source.frames, round(index * 0.02 * source.samplerate)))
            samples = source.read(round(source.samplerate * 0.14), always_2d=True)
            if len(samples) < 32:
                continue
            power = np.mean(
                abs(np.fft.rfft(samples * np.hanning(len(samples))[:, None], axis=0)) ** 2, axis=1
            )
            total = np.cumsum(power)
            if total[-1] > 1e-12:
                hz = np.fft.rfftfreq(len(samples), 1 / source.samplerate)
                bands.append(hz[np.searchsorted(total, total[-1] * np.array([0.05, 0.95]))])
            if len(bands) >= 16:
                break
    low, high = np.median(bands, axis=0) if bands else (0.0, 0.0)
    return float(low), float(high)
