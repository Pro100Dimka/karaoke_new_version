from __future__ import annotations

from types import MappingProxyType

import librosa
import numpy as np
from scipy.ndimage import maximum_filter1d, median_filter, uniform_filter1d
from scipy.signal import istft, stft

from backend.ai_worker.timing import _protected_frames, _runs
from backend.serialization import JsonValue

PARAMETERS: MappingProxyType[str, JsonValue] = MappingProxyType(
    {
        "fftSize": 4096,
        "hopSize": 512,
        "minimumRelativeChange": 0.05,
        "minimumRetainedPower": 0.4,
        "maximumPitchDeltaSemitones": 0.5,
        "weakTonePowerFraction": 0.1,
        "lowToneProtectionHz": 1100,
        "tonalContrast": 6,
        "tonalProtectionBins": 5,
        "minimumRegionSeconds": 0.12,
        "fadeSeconds": 0.02,
        "uncertainVoice": "preserve-original-region",
    }
)


def suppress_reverberation(
    raw: np.ndarray, dry: np.ndarray, rate: int
) -> tuple[np.ndarray, dict[str, JsonValue]]:
    """Apply a dry-vocal estimate only inside independently retained sung regions."""
    if (
        raw.ndim != 2
        or raw.shape != dry.shape
        or any(item.dtype.kind != "f" or not np.isfinite(item).all() for item in (raw, dry))
    ):
        raise ValueError("Reverberation cleanup requires finite aligned channel-first audio")
    if rate < 8000:
        raise ValueError("Invalid reverberation cleanup sample rate")
    result = raw.copy()
    regions: list[JsonValue] = []
    refused: list[JsonValue] = []
    report: dict[str, JsonValue] = {
        "algorithmVersion": "adaptive-reverb-1",
        "parameters": PARAMETERS.copy(),
        "regions": regions,
        "refusedRegions": refused,
    }
    if raw.shape[1] < 4096:
        return result, {**report, "decision": "unchanged:insufficient-context"}
    for channel, (before, candidate) in enumerate(zip(raw, dry)):
        times, allowed, refusals, candidate = _eligible_frames(before, candidate, rate)
        refused.extend({"channel": channel, **item} for item in refusals)
        for start, end in _runs(allowed, True):
            first = round(times[start] * rate)
            last = min(len(before), round((times[end - 1] + 512 / rate) * rate))
            details = _blend_region(result[channel], before, candidate, first, last, rate)
            target = regions if details["decision"] == "attenuated" else refused
            target.append({"channel": channel, **details})
    report["decision"] = "attenuated" if regions else "unchanged"
    return result, report


def _eligible_frames(
    raw: np.ndarray, dry: np.ndarray, rate: int
) -> tuple[np.ndarray, np.ndarray, list[dict[str, JsonValue]], np.ndarray]:
    _, times, spectrum = stft(raw, rate, nperseg=4096, noverlap=3584)
    dry_spectrum = stft(dry, rate, nperseg=4096, noverlap=3584)[2]
    power, dry_power = abs(spectrum) ** 2, abs(dry_spectrum) ** 2
    voiced = _protected_frames(power, times, rate, None, power)[1]
    dry_voiced = _protected_frames(dry_power, times, rate, None, dry_power)[1]
    pitches = [_pitch_curve(audio, times, rate) for audio in (raw, dry)]
    difference = abs(12 * np.log2(pitches[0] / pitches[1]))
    energy = np.maximum(power.sum(axis=0), 1e-20)
    relative = (abs(spectrum - dry_spectrum) ** 2).sum(axis=0) / energy
    retained = np.minimum(power, dry_power).sum(axis=0) / energy
    evidence = {
        "uncertain-source-voice": voiced,
        "voice-not-retained": dry_voiced & (retained > 0.4),
        "pitch-disagreement": difference < 0.5,
        "no-significant-reflections": relative > 0.05**2,
    }
    allowed = np.logical_and.reduce(list(evidence.values()))
    candidate, protected = _preserve_weak_tones(dry, spectrum, dry_spectrum, rate)
    evidence["weak-low-tone-preserved"] = ~protected
    return times, allowed, _refused_regions(evidence, times, len(raw), rate), candidate


def _refused_regions(
    evidence: dict[str, np.ndarray], times: np.ndarray, samples: int, rate: int
) -> list[dict[str, JsonValue]]:
    return [
        {
            "reason": reason,
            "start": float(times[start]),
            "end": min(samples / rate, float(times[end - 1] + 512 / rate)),
        }
        for reason, accepted in evidence.items()
        for start, end in _runs(~accepted, True)
    ]


def _pitch_curve(audio: np.ndarray, times: np.ndarray, rate: int) -> np.ndarray:
    frequency = librosa.yin(audio, fmin=65, fmax=1100, sr=rate, frame_length=4096, hop_length=512)
    return np.asarray(np.interp(times, np.arange(len(frequency)) * 512 / rate, frequency))


def _preserve_weak_tones(
    dry: np.ndarray, spectrum: np.ndarray, dry_spectrum: np.ndarray, rate: int
) -> tuple[np.ndarray, np.ndarray]:
    power = abs(spectrum) ** 2
    peak = power >= maximum_filter1d(power, 5, axis=0)
    tonal = power > median_filter(power, size=(31, 1)) * 6
    weak = uniform_filter1d(power, 5, axis=0) * 5 < power.sum(axis=0) * 0.1
    low = np.arange(len(power)) * rate / 4096 <= 1100
    protected = maximum_filter1d(peak & tonal & weak & low[:, None], 5, axis=0)
    # A dominant upper harmonic can hide a real weak fundamental from coarse F0.
    # Restore those original components; changing the pitch threshold cannot protect them.
    difference = np.where(protected, dry_spectrum - spectrum, 0)
    _, correction = istft(difference, rate, nperseg=4096, noverlap=3584)
    return dry - correction[: len(dry)].astype(dry.dtype), protected.any(axis=0)


def _blend_region(
    result: np.ndarray, raw: np.ndarray, dry: np.ndarray, first: int, last: int, rate: int
) -> dict[str, JsonValue]:
    details: dict[str, JsonValue] = {"start": first / rate, "end": last / rate}
    if last - first < 0.12 * rate:
        return {**details, "decision": "unchanged:short-supported-region"}
    gain = np.ones(last - first, dtype=raw.dtype)
    fade = min(round(0.02 * rate), len(gain) // 2)
    ramp = (0.5 - 0.5 * np.cos(np.linspace(0, np.pi, fade))).astype(raw.dtype)
    gain[:fade], gain[-fade:] = ramp, ramp[::-1]
    candidate = raw[first:last] + (dry[first:last] - raw[first:last]) * gain
    if np.max(abs(candidate)) > 1:
        return {**details, "decision": "unchanged:pcm-overflow"}
    result[first:last] = candidate
    return {**details, "decision": "attenuated", "preservation": "retained-voice-and-stable-pitch"}
