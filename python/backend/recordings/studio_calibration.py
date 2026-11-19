from dataclasses import dataclass
from pathlib import Path
import threading
import numpy as np
import soundfile as sf
from numpy.typing import NDArray
from scipy.ndimage import gaussian_filter1d, uniform_filter1d, maximum_filter1d, minimum_filter1d
from backend.recordings.studio_audio import MasterRenderer, _check_cancel, _profile
from backend.recordings.studio_delivery import measure_mix_loudness
from backend.recordings.studio_dynamics import _slow_gain_envelope

_STEP = 0.02
_REFERENCE_MAX_ATTENUATION_LU = 3.0


@dataclass(frozen=True, slots=True)
class GainPlan:
    times: NDArray[np.float64]
    gains: NDArray[np.float64]
    active: NDArray[np.bool_]
    target: NDArray[np.float64]
    offset: NDArray[np.float64]
    report: dict[str, object]
    presence: np.ndarray | None = None

    def report_automation(
        self, presence: np.ndarray, placement: np.ndarray, global_gain: float
    ) -> None:
        self.report.update(
            globalGainDb=global_gain,
            placementLu=float(np.median(placement[self.active])),
            presenceCompensationDb=float(np.median(presence[self.active])),
            localBalance={
                "stepSeconds": 0.5,
                "gainDb": self.gains[::25].round(2).tolist(),
                "presenceDb": presence[::25].round(2).tolist(),
                "placementLu": placement[::25].round(2).tolist(),
            },
            gainMinDb=float(np.min(self.gains)),
            gainMaxDb=float(np.max(self.gains)),
        )


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
    # Detect the actual 20 ms level; the gain envelope below provides the smoothing.
    level = rms + offset
    return times, level, m, meter_times, active, offset


def _accompaniment_levels(
    times: np.ndarray,
    music: np.ndarray,
    meter_times: np.ndarray,
) -> np.ndarray | None:
    # Near-silent backing must not drag down a continuing vocal phrase.
    audible = vocal_activity(music) & (music > -70) & (meter_times >= 0)
    if not audible.any():
        return None
    accompaniment = 10 * np.log10(
        gaussian_filter1d(10 ** (music[audible] / 10), sigma=4, mode="nearest")
    )
    return np.asarray(np.interp(times, meter_times[audible], accompaniment), dtype=float)


def _target_levels(
    times: np.ndarray,
    level: np.ndarray,
    music: np.ndarray,
    meter_times: np.ndarray,
    baseline: np.ndarray,
    placement: np.ndarray,
) -> np.ndarray:
    accompaniment = _accompaniment_levels(times, music, meter_times)
    target = baseline.copy() if accompaniment is None else accompaniment + placement
    # Retain phrase emphasis while keeping unusually loud syllables inside the backing.
    return np.asarray(target + 0.4 * np.minimum(level - baseline, 5.0), dtype=float)


def _presence_correction(
    voice: Path,
    backing: Path,
    times: np.ndarray,
    gains: np.ndarray,
    active: np.ndarray,
    placement: float | np.ndarray,
    cancel: threading.Event,
) -> np.ndarray:
    vocal = _profile(voice, cancel, voice_band=True, band_hz=(600, 3500))
    full = _profile(voice, cancel)
    music = _profile(backing, cancel, voice_band=True, center=True, band_hz=(600, 3500))
    axis = (np.arange(len(vocal)) + 0.5) * 0.1
    full = np.interp(times, axis, full)
    vocal = np.interp(times, axis, vocal)
    music = np.interp(times, axis, music)
    voicing = _voicing_profile(voice, cancel)
    confidence = np.interp(times, (np.arange(len(voicing)) + 0.5) * 0.04, voicing)
    valid = active & (music > -70) & (vocal > -80) & (vocal > full - 20)
    valid &= confidence >= 0.65
    correction = np.where(
        valid, np.clip(placement - (vocal + gains - music), 0, np.clip(3.0 - placement, 3, 6)), 0
    )
    return np.asarray(gaussian_filter1d(correction, sigma=0.25 / _STEP, mode="nearest"))


def _voicing_profile(voice: Path, cancel: threading.Event) -> np.ndarray:
    confidence = []
    with sf.SoundFile(voice) as source:
        size = max(1, round(source.samplerate * 0.04))
        transform = 2 ** int(np.ceil(np.log2(2 * size)))
        hz = np.fft.rfftfreq(transform, 1 / source.samplerate)
        for block in source.blocks(blocksize=size * 32, always_2d=True):
            _check_cancel(cancel)
            complete = len(block) // size * size
            for frames in (
                block[:complete].reshape(-1, size, source.channels),
                block[complete:][None, :, :],
            ):
                if not frames.size:
                    continue
                power = np.sum(abs(np.fft.rfft(frames, n=transform, axis=1)) ** 2, axis=2)
                power[:, (hz < 150) | (hz > 3500)] = 0
                correlation = np.fft.irfft(power, n=transform, axis=1)
                low, high = max(1, round(source.samplerate / 500)), round(source.samplerate / 70)
                peak = np.max(correlation[:, low:high], axis=1) / np.maximum(
                    correlation[:, 0], 1e-20
                )
                confidence.extend(peak.tolist())
    return np.asarray(confidence)


def _protect_unvoiced(
    voice: Path,
    times: np.ndarray,
    desired: np.ndarray,
    active: np.ndarray,
    cancel: threading.Event,
) -> tuple[np.ndarray, dict[str, object]]:
    profile = _voicing_profile(voice, cancel)
    confidence = np.interp(times, (np.arange(len(profile)) + 0.5) * 0.04, profile)
    voiced = (
        minimum_filter1d((active & (confidence >= 0.65)).astype(float), size=7, mode="constant") > 0
    )
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


def _context_levels(
    times: np.ndarray,
    level: np.ndarray,
    active: np.ndarray,
    overlap: float,
    reference_balance: tuple[np.ndarray, np.ndarray, np.ndarray] | None,
) -> tuple[np.ndarray, np.ndarray]:
    baseline = gaussian_filter1d(level * active, sigma=0.75 / _STEP, mode="nearest")
    baseline /= np.maximum(
        gaussian_filter1d(active.astype(float), sigma=0.75 / _STEP, mode="nearest"), 1e-9
    )
    placement = np.full_like(level, -3.0 + 3.0 * overlap)
    if reference_balance is None:
        return baseline, placement
    positions, vocal, music = reference_balance
    accompaniment = _accompaniment_levels(positions, music, positions)
    if accompaniment is None:
        return baseline, placement
    valid = vocal_activity(vocal) & (vocal > -70) & (music > -70)
    if np.count_nonzero(valid) < 10:
        return baseline, placement
    confidence = np.clip((vocal - np.percentile(vocal[valid], 80) + 12) / 6, 0, 1)
    strong = valid & (music >= np.percentile(music[valid], 70)) & (confidence >= 0.5)
    # Compare against the same smoothed/held accompaniment used by the target.
    # Raw reference levels would compensate backing gaps a second time, including
    # the partially filled loudness windows at each boundary.
    ratio = vocal - accompaniment
    anchor = float(np.median(ratio[strong if strong.any() else valid]))
    relative = np.interp(positions, positions[valid], ratio[valid]) - anchor
    phrase = np.clip(_slow_gain_envelope(relative, seconds=3.0), -_REFERENCE_MAX_ATTENUATION_LU, 24)
    reliable = gaussian_filter1d(confidence * valid, sigma=5, mode="nearest")
    placement += np.interp(times, positions, phrase * reliable)
    return baseline, placement


def build_gain_plan(
    renderer: MasterRenderer,
    voice: Path,
    backing: Path,
    overlap: float,
    cancel: threading.Event,
    *,
    reference_balance: tuple[np.ndarray, np.ndarray, np.ndarray] | None = None,
) -> GainPlan:
    times, level, music, meter_times, active, offset = _detector(renderer, voice, backing, cancel)
    report: dict[str, object] = {
        "method": "single-context-envelope",
        "activeSeconds": float(np.count_nonzero(active) * _STEP),
    }
    if not active.any():
        return GainPlan(times, np.zeros_like(level), active, level, offset, report)
    baseline, placement = _context_levels(times, level, active, overlap, reference_balance)
    target = _target_levels(times, level, music, meter_times, baseline, placement)
    # Support softer words before breath protection, without flattening the whole performance.
    soft_word_lift = np.clip((baseline - level) * 0.15, 0.0, 2.0)
    target += soft_word_lift
    desired, protection = _protect_unvoiced(voice, times, target - level, active, cancel)
    # Include breath protection's attenuation when measuring the final vocal presence.
    presence_target = np.maximum(placement, -3.0 + 3.0 * overlap)
    presence = _presence_correction(voice, backing, times, desired, active, presence_target, cancel)
    desired += presence + 1.5
    report["unvoicedProtection"] = protection
    global_gain = float(np.median(desired[active]))
    gains = _smoothed_gains(times, desired, active, global_gain)
    report.update(
        vocalLiftDb=1.5,
        softWordLiftMaxDb=float(np.max(soft_word_lift[active])),
        presenceBandHz=[600, 3500],
        overlap=overlap,
        dynamicRangeDb=float(np.ptp(np.percentile(desired[active], [10, 90]))),
    )
    plan = GainPlan(times, gains, active, level + desired, offset, report, presence)
    plan.report_automation(presence, placement, global_gain)
    return plan


def _smoothed_gains(
    times: np.ndarray, desired: np.ndarray, active: np.ndarray, global_gain: float
) -> np.ndarray:
    # Look ahead one frame so smoothing cannot let a short loud syllable escape its own gain.
    envelope = minimum_filter1d(np.interp(times, times[active], desired[active]), size=3)
    gains = gaussian_filter1d(envelope, sigma=0.02 / _STEP, mode="nearest")
    gate = gaussian_filter1d(
        maximum_filter1d(active.astype(float), size=9), sigma=1, mode="nearest"
    )
    result: NDArray[np.float64] = gate * gains + (1 - gate) * min(global_gain, 0)
    return result


def validate_gain_plan(voice: Path, plan: GainPlan, cancel: threading.Event) -> dict[str, object]:
    rms = _profile(voice, cancel, frame_seconds=_STEP)
    measured, expected = [
        10
        * np.log10(
            np.maximum(gaussian_filter1d(10 ** (values / 10), sigma=1.5, mode="nearest"), 1e-12)
        )
        + plan.offset
        for values in (rms, plan.target - plan.offset)
    ]
    error = np.abs((measured - expected)[plan.active])
    p90 = float(np.percentile(error, 90)) if error.size else 0.0
    return {
        "method": "measured-envelope-residual",
        "p90ErrorDb": p90,
        "status": "within-range" if p90 <= 3 else "limited",
        "gainApplications": 1,
    }
