from dataclasses import dataclass
from pathlib import Path
import threading
import numpy as np
import soundfile as sf
from numpy.typing import NDArray
from scipy.ndimage import gaussian_filter1d, uniform_filter1d, maximum_filter1d, minimum_filter1d
from backend.recordings.studio_audio import MasterRenderer, _check_cancel, _profile
from backend.recordings.studio_delivery import measure_mix_loudness

_STEP = 0.02


@dataclass(frozen=True, slots=True)
class GainPlan:
    times: NDArray[np.float64]
    gains: NDArray[np.float64]
    active: NDArray[np.bool_]
    target: NDArray[np.float64]
    offset: NDArray[np.float64]
    report: dict[str, object]


def vocal_activity(levels: NDArray[np.float64]) -> NDArray[np.bool_]:
    floor = max(
        -80.0, min(float(np.percentile(levels, 80)) - 24, float(np.percentile(levels, 10)) + 10)
    )
    return levels > floor


def _detector(
    renderer: MasterRenderer, voice: Path, backing: Path, cancel: threading.Event
) -> tuple[np.ndarray, ...]:
    rms = _profile(voice, cancel, frame_seconds=_STEP)
    band = _profile(voice, cancel, voice_band=True)
    v, m = measure_mix_loudness(renderer, voice, backing, cancel)
    times = (np.arange(len(rms)) + 0.5) * _STEP
    meter_times = (np.arange(len(v)) + 1) * 0.1 - 0.2
    active = (
        np.interp(times, (np.arange(len(band)) + 0.5) * 0.1, vocal_activity(band).astype(float))
        > 0.5
    )
    if not active.any() and np.max(rms) > -80:
        active = vocal_activity(rms)
    broad = 10 * np.log10(
        np.maximum(uniform_filter1d(10 ** (rms / 10), size=20, mode="nearest"), 1e-12)
    )
    valid = (v > -70) & (meter_times >= 0)
    if not valid.any():
        return times, rms, m, meter_times, active & False, np.zeros_like(rms)
    offsets = v[valid] - np.interp(meter_times[valid], times, broad)
    offset = np.interp(
        times, meter_times[valid], gaussian_filter1d(offsets, sigma=2, mode="nearest")
    )
    level = (
        10
        * np.log10(
            np.maximum(gaussian_filter1d(10 ** (rms / 10), sigma=1.5, mode="nearest"), 1e-12)
        )
        + offset
    )
    return times, level, m, meter_times, active, offset


def _target_levels(
    times: np.ndarray,
    level: np.ndarray,
    music: np.ndarray,
    meter_times: np.ndarray,
    baseline: float,
    placement: float,
) -> np.ndarray:
    audible = (music > -70) & (meter_times >= 0)
    if audible.any():
        accompaniment = 10 * np.log10(
            gaussian_filter1d(10 ** (music[audible] / 10), sigma=4, mode="nearest")
        )
        target = np.interp(times, meter_times[audible], accompaniment) + placement
    else:
        target = np.full_like(level, baseline)
    return np.asarray(target + 0.15 * (level - baseline), dtype=float)


def _presence_correction(
    voice: Path,
    backing: Path,
    times: np.ndarray,
    gains: np.ndarray,
    active: np.ndarray,
    placement: float,
    cancel: threading.Event,
) -> float:
    vocal = _profile(voice, cancel, voice_band=True, band_hz=(600, 3500))
    full = _profile(voice, cancel)
    if np.mean(10 ** (vocal / 10)) < 0.01 * np.mean(10 ** (full / 10)):
        return 0.0
    music = _profile(backing, cancel, voice_band=True, center=True, band_hz=(600, 3500))
    axis = (np.arange(len(vocal)) + 0.5) * 0.1
    vocal = np.interp(times, axis, vocal)
    music = np.interp(times, axis, music)
    valid = active & (music > -70) & (vocal > -80)
    if not valid.any():
        return 0.0
    prominence = float(np.median((vocal + gains - music)[valid]))
    return float(np.clip(placement - prominence, 0, -placement))


def _voicing_profile(voice: Path, cancel: threading.Event) -> np.ndarray:
    confidence = []
    with sf.SoundFile(voice) as source:
        size = max(1, round(source.samplerate * 0.04))
        transform = 2 ** int(np.ceil(np.log2(2 * size)))
        hz = np.fft.rfftfreq(transform, 1 / source.samplerate)
        for block in source.blocks(blocksize=size, always_2d=True):
            _check_cancel(cancel)
            power = np.sum(abs(np.fft.rfft(block, n=transform, axis=0)) ** 2, axis=1)
            power[(hz < 150) | (hz > 3500)] = 0
            correlation = np.fft.irfft(power, n=transform)
            low, high = max(1, round(source.samplerate / 500)), round(source.samplerate / 70)
            peak = float(np.max(correlation[low:high])) / max(float(correlation[0]), 1e-20)
            confidence.append(peak)
    return np.asarray(confidence)


def _protect_unvoiced(
    voice: Path, times: np.ndarray, desired: np.ndarray, active: np.ndarray,
    cancel: threading.Event,
) -> tuple[np.ndarray, dict[str, object]]:
    profile = _voicing_profile(voice, cancel)
    confidence = np.interp(times, (np.arange(len(profile)) + 0.5) * 0.04, profile)
    voiced = minimum_filter1d(
        (active & (confidence >= 0.65)).astype(float), size=7, mode="constant"
    ) > 0
    reduction = np.zeros_like(desired)
    if voiced.any():
        body_gain = minimum_filter1d(np.where(voiced, desired, np.inf), size=21)
        neighboring = np.interp(times, times[voiced], body_gain[voiced])
        weight = np.clip((0.65 - confidence) / 0.2, 0, 1)
        reduction = weight * np.maximum(desired - neighboring, 0)
    return desired - reduction, {
        "method": "neighboring-voiced-gain-ceiling",
        "protectedSeconds": float(np.count_nonzero(reduction > 1) * _STEP),
        "maxReductionDb": float(np.max(reduction)),
    }


def build_gain_plan(
    renderer: MasterRenderer, voice: Path, backing: Path, overlap: float, cancel: threading.Event
) -> GainPlan:
    times, level, music, meter_times, active, offset = _detector(renderer, voice, backing, cancel)
    report: dict[str, object] = {
        "method": "single-context-envelope",
        "activeSeconds": float(np.count_nonzero(active) * _STEP),
    }
    if not active.any():
        return GainPlan(times, np.zeros_like(level), active, level, offset, report)
    baseline = float(np.median(level[active]))
    placement = -6.0 + 3.0 * overlap
    target = _target_levels(times, level, music, meter_times, baseline, placement)
    presence = _presence_correction(
        voice, backing, times, target - level, active, placement, cancel
    )
    target += presence
    desired, protection = _protect_unvoiced(voice, times, target - level, active, cancel)
    target = level + desired
    report["unvoicedProtection"] = protection
    global_gain = float(np.median(desired[active]))
    gains = gaussian_filter1d(
        np.interp(times, times[active], desired[active]), sigma=1, mode="nearest"
    )
    gate = gaussian_filter1d(
        maximum_filter1d(active.astype(float), size=9), sigma=1, mode="nearest"
    )
    gains = gate * gains + (1 - gate) * min(global_gain, 0)
    report.update(
        globalGainDb=global_gain,
        placementLu=placement,
        presenceCompensationDb=presence,
        presenceBandHz=[600, 3500],
        overlap=overlap,
        dynamicRangeDb=float(np.ptp(np.percentile(desired[active], [10, 90]))),
        gainMinDb=float(np.min(gains)),
        gainMaxDb=float(np.max(gains)),
    )
    return GainPlan(times, gains, active, target, offset, report)


def validate_gain_plan(voice: Path, plan: GainPlan, cancel: threading.Event) -> dict[str, object]:
    rms = _profile(voice, cancel, frame_seconds=_STEP)
    measured = (
        10
        * np.log10(
            np.maximum(gaussian_filter1d(10 ** (rms / 10), sigma=1.5, mode="nearest"), 1e-12)
        )
        + plan.offset
    )
    error = np.abs((measured - plan.target)[plan.active])
    p90 = float(np.percentile(error, 90)) if error.size else 0.0
    return {
        "method": "measured-envelope-residual",
        "p90ErrorDb": p90,
        "status": "within-range" if p90 <= 3 else "limited",
        "gainApplications": 1,
    }
