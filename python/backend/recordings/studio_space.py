from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
import math
import threading

import numpy as np
import soundfile as sf
from scipy.ndimage import median_filter
from scipy.signal import butter, find_peaks, resample_poly, sosfilt

from backend.recordings.studio_audio import MasterRenderer, _check_cancel
from backend.domain_errors import DependencyError


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


def apply_reference_space(
    renderer: MasterRenderer,
    reference: Path,
    recorded: Path,
    voice: Path,
    target: Path,
    cancel: threading.Event,
) -> dict[str, object]:
    expected = analyze_space(reference, cancel)
    existing = analyze_space(recorded, cancel)
    selected = match_space(expected, existing)
    method = "reference-cepstrum-pause-decay-and-stereo"
    if not (selected.delay_gain or selected.reverb_gain):
        # A separated reference often has no isolated pauses, so absence of
        # measurable tails is NOT evidence that the production is dry.
        # Estimate only a bounded room impression; do not invent an echo.
        width = _reference_width(reference, cancel)
        recorded_width = _reference_width(recorded, cancel)
        if width > recorded_width + 0.025:
            selected = SpaceProfile(
                decay_seconds=float(np.clip(0.28 + 0.45 * width, 0.28, 0.65)),
                reverb_gain=float(np.clip(0.12 + 0.12 * (width - recorded_width), 0.12, 0.20)),
                stereo_width=width,
                effect_type="subtle-room",
            )
            method = "reference-width-informed-room"
    applied = bool(selected.delay_gain or selected.reverb_gain)
    if applied:
        info = sf.info(voice)
        impulse = target.with_suffix(".ir.wav")
        write_impulse(selected, impulse, info.samplerate, info.channels)
        renderer._mix(
            voice,
            impulse,
            "[0:a][1:a]afir=dry=1:wet=1:irnorm=-1:irgain=1,"
            f"apad,atrim=end_sample={info.frames}[out]",
            ["-c:a", "pcm_f32le", str(target)],
            cancel,
        )
    return {
        "method": method,
        "effectDetection": {"delay": expected.effect_type if expected.delay_gain else "not-confident", "delayConfidence": expected.delay_support, "reverbEvidenceCount": expected.decay_count, "referenceStereoWidth": expected.stereo_width, "recordedStereoWidth": existing.stereo_width},
        "status": "matched" if applied else "no-supported-addition",
        "reference": asdict(expected),
        "recorded": asdict(existing),
        "applied": asdict(selected),
    }


def _reference_width(path: Path, cancel: threading.Event) -> float:
    """Robust stereo difference ratio from active blocks, bounded to [0, 1].

    Width alone cannot prove the presence or settings of a reverb. It is used
    only to choose a restrained fallback when direct tail evidence is absent.
    """
    values: list[float] = []
    with sf.SoundFile(path) as source:
        if source.channels < 2:
            return 0.0
        for index, samples in enumerate(source.blocks(
            blocksize=source.samplerate, dtype="float32", always_2d=True
        )):
            _check_cancel(cancel)
            if index >= 90:
                break
            left, right = samples[:, 0], samples[:, 1]
            power = float(np.mean(left * left + right * right))
            if power > 1e-7:
                difference = float(np.mean((left - right) ** 2))
                values.append(float(np.clip(difference / power, 0, 1)))
    return float(np.median(values)) if values else 0.0


def analyze_space(path: Path, cancel: threading.Event) -> SpaceProfile:
    levels, cepstra = _read_evidence(path, cancel)
    delay, gain, support = _delay(cepstra)
    decay, wet, count = _decay(levels)
    width = _reference_width(path, cancel)
    kind = ("slapback" if delay < 0.12 else "delay") if gain else "none"
    return SpaceProfile(delay, gain, support, decay, wet, count, width, kind)


def match_space(reference: SpaceProfile, existing: SpaceProfile) -> SpaceProfile:
    # Existing recorded tails cannot be shortened by adding another effect.
    reverb = (
        math.sqrt(max(0, reference.reverb_gain**2 - existing.reverb_gain**2))
        if existing.decay_seconds <= reference.decay_seconds
        else 0.0
    )
    return SpaceProfile(
        delay_seconds=reference.delay_seconds,
        delay_gain=float(np.clip(reference.delay_gain - existing.delay_gain, 0, 0.35)),
        delay_support=reference.delay_support,
        decay_seconds=reference.decay_seconds,
        reverb_gain=float(np.clip(reverb, 0, 0.35)),
        decay_count=reference.decay_count,
        stereo_width=reference.stereo_width,
        effect_type=reference.effect_type,
    )


def write_impulse(profile: SpaceProfile, path: Path, rate: int, channels: int) -> None:
    length = round((max(profile.decay_seconds, profile.delay_seconds, 0.02) + 0.02) * rate)
    impulse = np.zeros((length, channels), dtype=np.float64)
    impulse[0] = 1
    if profile.delay_gain:
        delay_index = round(profile.delay_seconds * rate)
        if 0 < delay_index < length:
            # Preserve the centered dry signal; place repeat energy in the sides.
            if channels >= 2 and profile.stereo_width > 0.08:
                impulse[delay_index, 0] += profile.delay_gain
                opposite = min(length - 1, delay_index + round(0.017 * rate))
                impulse[opposite, 1] += profile.delay_gain * 0.85
                if channels > 2:
                    impulse[delay_index, 2:] += profile.delay_gain * 0.5
            else:
                impulse[delay_index] += profile.delay_gain
    if profile.reverb_gain and profile.decay_seconds > 0:
        start = round(0.02 * rate)
        time = np.arange(length - start) / rate
        noise = np.random.default_rng(0).normal(size=(len(time), channels))
        band = butter(2, [180, min(6000, rate * 0.45)], btype="bandpass", fs=rate, output="sos")
        tail = sosfilt(band, noise, axis=0) * np.exp(
            -6.9078 * time[:, None] / profile.decay_seconds
        )
        tail /= np.maximum(np.linalg.norm(tail, axis=0), 1e-12)
        if channels >= 2 and profile.stereo_width > 0.08:
            # Independent diffuse tails widen only the wet component.
            tail[:, :2] *= min(1.0, 0.65 + profile.stereo_width)
        impulse[start:] += profile.reverb_gain * tail
    sf.write(path, impulse, rate, subtype="FLOAT")


def _read_evidence(path: Path, cancel: threading.Event) -> tuple[np.ndarray, np.ndarray]:
    levels: list[float] = []
    cepstra: list[np.ndarray] = []
    energies: list[float] = []
    with sf.SoundFile(path) as source:
        block = source.samplerate * 2
        stride = max(1, math.ceil(source.frames / block / 96))
        step = max(1, round(source.samplerate * 0.02))
        for index, samples in enumerate(source.blocks(blocksize=block, always_2d=True)):
            _check_cancel(cancel)
            if not np.isfinite(samples).all():
                raise DependencyError("StudioMasterInvalidAudio", "Audio contains invalid samples")
            samples = samples[:, :2]
            usable = len(samples) // step * step
            if usable:
                power = np.mean(
                    samples[:usable].reshape(-1, step, samples.shape[1]) ** 2, axis=(1, 2)
                )
                levels.extend(10 * np.log10(np.maximum(power, 1e-12)))
            if index % stride == 0 and len(samples) == block:
                energies.append(float(np.mean(samples * samples)))
                cepstra.append(_cepstrum(samples, source.samplerate))
    if not energies:
        return np.asarray(levels), np.empty((0, 8193))
    active = np.asarray(energies) > max(1e-8, float(np.percentile(energies, 75)) / 100)
    return np.asarray(levels), np.asarray(cepstra)[active]


def _cepstrum(samples: np.ndarray, rate: int) -> np.ndarray:
    divisor = math.gcd(rate, 8000)
    audio = resample_poly(samples, 8000 // divisor, rate // divisor, axis=0)
    # A tapered window changes the direct/echo ratio at different delays.
    # Use untapered blocks and require the peak to persist across independent blocks.
    spectrum = np.abs(np.fft.rfft(audio, n=16384, axis=0))
    logarithm = np.log(np.maximum(spectrum, np.max(spectrum) * 1e-8 + 1e-12))
    return np.mean(np.fft.irfft(logarithm, n=16384, axis=0), axis=1)[:8193]


def _delay(cepstra: np.ndarray) -> tuple[float, float, float]:
    if len(cepstra) < 6:
        return 0, 0, 0
    # Persistent long-quefrency peaks indicate a delayed copy, not vocal pitch.
    curve = np.median(cepstra, axis=0)
    # 40–600 ms: include short slapback while excluding the voiced pitch region.
    lower, upper = 320, 4800
    noise = float(np.median(np.abs(curve[lower:upper])))
    peaks, _ = find_peaks(curve[lower:upper], height=max(0.015, noise * 10), distance=80)
    if not len(peaks):
        return 0, 0, 0
    index = int(peaks[np.argmax(curve[lower:upper][peaks])] + lower)
    agreeing = cepstra[:, index] > max(0.01, noise * 6)
    support = float(np.mean(agreeing))
    if support < 0.7:
        return 0, 0, support
    seconds = index / 8000
    # A block boundary can cut off a repeat. Estimate strength from the upper
    # quartile of agreeing blocks, rather than treating cut tails as a quieter effect.
    gain = float(np.clip(2 * np.percentile(cepstra[agreeing, index], 75), 0, 0.30))
    return seconds, gain, support


def _decay(levels: np.ndarray) -> tuple[float, float, int]:
    if len(levels) < 150 or np.percentile(levels, 80) - np.percentile(levels, 10) < 15:
        return 0, 0, 0
    smooth = median_filter(levels, size=3)
    floor = max(-85.0, float(np.percentile(smooth, 10)) + 6)
    candidates = np.flatnonzero(smooth[:-2] - smooth[2:] > 5) + 2
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


def apply_fallback_space(
    renderer: MasterRenderer, voice: Path, backing: Path, target: Path, cancel: threading.Event
) -> dict[str, object]:
    """Add subtle room coherence only when the reference offers no usable space cues.

    This is a deterministic, low-wet, peak-safe fallback, not an inferred
    reconstruction of the original singer's room.
    """
    with sf.SoundFile(backing) as music:
        rate = music.samplerate
        # Use only the original stereo pair; duplicate surround channels are
        # not independent evidence of spatial width.
        width = []
        for index, block in enumerate(music.blocks(blocksize=rate, always_2d=True)):
            _check_cancel(cancel)
            if index >= 20:
                break
            if block.shape[1] < 2:
                continue
            left, right = block[:, 0], block[:, 1]
            power = float(np.mean(left * left + right * right))
            if power > 1e-9:
                width.append(float(np.mean((left - right) ** 2) / power))
    stereo_width = float(np.median(width)) if width else 0.0
    # Mono/dry backing: short ambience. Wide backing: slightly longer tail.
    decay = float(np.clip(0.22 + stereo_width * 0.25, 0.22, 0.48))
    strength = 0.08 if stereo_width < 0.08 else 0.12
    info = sf.info(voice)
    profile = SpaceProfile(decay_seconds=decay, reverb_gain=strength, decay_count=0)
    impulse = target.with_suffix(".ir.wav")
    write_impulse(profile, impulse, info.samplerate, info.channels)
    renderer._mix(
        voice, impulse,
        "[0:a][1:a]afir=dry=1:wet=1:irnorm=-1:irgain=1,"
        f"apad,atrim=end_sample={info.frames}[out]",
        ["-c:a", "pcm_f32le", str(target)], cancel,
    )
    return {"method": "bounded-room-fallback", "decaySeconds": decay,
            "wetImpulseGain": strength, "backingStereoWidth": stereo_width}
