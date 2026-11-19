from dataclasses import dataclass, replace
from pathlib import Path
import threading
import numpy as np
from numpy.typing import NDArray
from scipy.ndimage import gaussian_filter1d, maximum_filter1d, minimum_filter1d
from backend.recordings.studio_audio import MasterRenderer, _check_cancel, _profile
from backend.recordings.studio_delivery import measure_mix_loudness
from backend.recordings.studio_dynamics import _slow_gain_envelope
from backend.recordings.studio_leveling import correction_response, local_outlier_gain
from backend.recordings.studio_clarity import measure_reference_clarity
from backend.recordings.studio_vocal_context import (
    ReferenceBody,
    ReferenceLevels,
    measured_levels,
    vocal_activity as vocal_activity,
    voiced_activity as _voiced_activity,
    voicing_profile as _voicing_profile,
)

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
    clarity: np.ndarray | None = None
    clarity_bands: np.ndarray | None = None

    @property
    def clarity_need(self) -> np.ndarray | None:
        return self.presence if self.clarity is None else self.clarity

    @property
    def clarity_limit(self) -> float:
        if self.clarity is None or self.report.get("balanceBasis") != "verified-source-reference":
            return 3.0
        supported = self.active & (self.clarity >= 1)
        return min(float(np.median(self.clarity[supported])), 3.0) if supported.any() else 0.0

    def report_dynamics(
        self,
        soft_word_lift: np.ndarray,
        overlap: float,
        desired: np.ndarray,
        reference_verified: bool = False,
    ) -> None:
        self.report.update(
            leveling="slow-placement-and-local-outliers",
            vocalLiftDb=0.0 if reference_verified else 1.5,
            balanceBasis=(
                "verified-source-reference"
                if reference_verified
                else "uncalibrated-reference-fallback"
            ),
            baselineMethod=(
                "voiced-power-with-local-peak-bound" if reference_verified else "voiced-log-mean"
            ),
            softWordLiftMaxDb=float(np.max(soft_word_lift[self.active])),
            presenceBandHz=[600, 3500],
            overlap=overlap,
            dynamicRangeDb=float(np.ptp(np.percentile(desired[self.active], [10, 90]))),
        )

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


def _detector(
    renderer: MasterRenderer, voice: Path, backing: Path, cancel: threading.Event
) -> tuple[np.ndarray, ...]:
    vocal, music = measure_mix_loudness(renderer, voice, backing, cancel)
    meter_times = (np.arange(len(vocal)) + 1) * 0.1 - 0.2
    times, level, active, offset = measured_levels(voice, meter_times, vocal, cancel)
    return times, level, music, meter_times, active, offset


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
    # Placement follows the phrase baseline. Local dynamics are handled separately,
    # so ordinary emphasis is not forced toward the backing every 20 milliseconds.
    return np.asarray(target + level - baseline, dtype=float)


def _presence_correction(
    voice: Path,
    backing: Path,
    times: np.ndarray,
    gains: np.ndarray,
    active: np.ndarray,
    placement: float | np.ndarray,
    cancel: threading.Event,
    reference_verified: bool = False,
) -> np.ndarray:
    if reference_verified:
        # The verified full-band reference already owns the placement target.
        # A fixed presence floor would silently override a deliberately softer mix.
        return np.zeros_like(times)
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


def _body_context(
    times: np.ndarray,
    level: np.ndarray,
    active: np.ndarray,
    voiced: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    body = voiced if voiced.any() else active
    baseline = gaussian_filter1d(level * body, sigma=0.75 / _STEP, mode="nearest")
    coverage = gaussian_filter1d(body.astype(float), sigma=0.75 / _STEP, mode="nearest")
    baseline /= np.maximum(coverage, 1e-9)
    # Long unvoiced passages have no nearby body evidence, not a 0 dBFS baseline.
    missing = coverage <= 1e-9
    baseline[missing] = np.interp(times[missing], times[body], level[body])
    return baseline, coverage, body


def _context_levels(
    times: np.ndarray,
    level: np.ndarray,
    active: np.ndarray,
    overlap: float,
    reference_balance: tuple[np.ndarray, np.ndarray, np.ndarray] | None,
    reference_level_correction_db: float | None = None,
    *,
    voiced: np.ndarray,
    paired_body: bool = False,
) -> tuple[np.ndarray, np.ndarray, bool]:
    baseline, coverage, body = _body_context(times, level, active, voiced)
    placement, verified = _reference_placement(
        times, overlap, reference_balance, reference_level_correction_db, paired_body=paired_body
    )
    if verified:
        baseline = _placement_baseline(level, baseline, body, coverage, active)
    return baseline, placement, verified


def _placement_baseline(
    level: np.ndarray,
    baseline: np.ndarray,
    voiced: np.ndarray,
    coverage: np.ndarray,
    active: np.ndarray,
) -> np.ndarray:
    # Quiet pitched tails must contribute their energy, not equal-weight dB
    # offsets. Existing local peak control bounds the evidence for an isolated
    # accent so it cannot lower the surrounding voice through this slow mean.
    # Use the controller's activity for that bound, preserving breath gaps;
    # only the existing voiced mask contributes to the power mean itself.
    evidence = level + np.minimum(local_outlier_gain(level, baseline, active, _STEP), 0)
    power = gaussian_filter1d(10 ** (evidence / 10) * voiced, sigma=0.75 / _STEP, mode="nearest")
    result = 10 * np.log10(np.maximum(power / np.maximum(coverage, 1e-9), 1e-12))
    missing = coverage <= 1e-9
    result[missing] = baseline[missing]
    return np.asarray(result, dtype=float)


def measure_reference_body(
    voice: Path, meter_times: np.ndarray, momentary: np.ndarray, cancel: threading.Event
) -> ReferenceBody | None:
    times, level, active, _ = measured_levels(voice, meter_times, momentary, cancel)
    voiced = _voiced_activity(voice, times, active, cancel)
    if np.count_nonzero(voiced) * _STEP < 1:
        return None
    baseline, coverage, body = _body_context(times, level, active, voiced)
    power = gaussian_filter1d(10 ** (level / 10) * body, sigma=0.75 / _STEP, mode="nearest")
    measured = 10 * np.log10(np.maximum(power / np.maximum(coverage, 1e-9), 1e-12))
    baseline = np.where(coverage > 1e-9, measured, baseline)
    # The reference is the desired measured energy. Only the take is going
    # through local peak control; applying that controller to this measurement
    # too would count its reduction again when constructing the target.
    _check_cancel(cancel)
    return ReferenceBody(times, baseline, voiced)


def _body_reference_balance(
    balance: tuple[np.ndarray, np.ndarray, np.ndarray] | None,
    body: ReferenceBody | None,
    correction: float | None,
) -> tuple[tuple[np.ndarray, np.ndarray, np.ndarray] | None, bool]:
    if balance is None or body is None or correction is None or not np.isfinite(correction):
        return balance, False
    positions, _, music = balance
    measured = body.on_grid(positions)
    if np.count_nonzero(measured.supported & (music > -70)) < 10:
        return balance, False
    vocal = np.where(measured.supported, measured.levels, -120.0)
    return (positions, vocal, music), True


def _reference_placement(
    times: np.ndarray,
    overlap: float,
    reference_balance: tuple[np.ndarray, np.ndarray, np.ndarray] | None,
    correction_db: float | None,
    *,
    paired_body: bool = False,
) -> tuple[np.ndarray, bool]:
    placement = np.full_like(times, -3.0 + 3.0 * overlap)
    if reference_balance is None:
        return placement, False
    positions, vocal, music = reference_balance
    accompaniment = _accompaniment_levels(positions, music, positions)
    if accompaniment is None:
        return placement, False
    valid = vocal_activity(vocal) & (vocal > -70) & (music > -70)
    if np.count_nonzero(valid) < 10:
        return placement, False
    confidence = np.clip((vocal - np.percentile(vocal[valid], 80) + 12) / 6, 0, 1)
    strong = valid & (music >= np.percentile(music[valid], 70)) & (confidence >= 0.5)
    # Compare against the same smoothed/held accompaniment used by the target.
    # Raw reference levels would compensate backing gaps a second time, including
    # the partially filled loudness windows at each boundary.
    ratio = vocal - accompaniment
    anchor = float(np.median(ratio[strong if strong.any() else valid]))
    relative = np.interp(positions, positions[valid], ratio[valid]) - anchor
    phrase = _slow_gain_envelope(relative, seconds=3.0)
    verified = False
    if correction_db is not None and np.isfinite(correction_db):
        placement[:] = anchor + correction_db
        verified = True
        reliability = _reference_reliability(valid, music, paired_body)
    else:
        phrase = np.clip(phrase, -_REFERENCE_MAX_ATTENUATION_LU, 24)
        reliability = confidence * valid
    reliable = gaussian_filter1d(reliability, sigma=5, mode="nearest")
    placement += np.interp(times, positions, phrase * reliable)
    return placement, verified


def _reference_reliability(valid: np.ndarray, music: np.ndarray, paired_body: bool) -> np.ndarray:
    # Voicing decides evidence sufficiency, not the size of a verified phrase
    # change. Hold context within the same three-second phrase window instead
    # of scaling a quiet phrase by its word duty.
    reliability = valid.astype(float)
    if paired_body:
        reliability = maximum_filter1d(reliability, size=31)
    return np.asarray(reliability * (music > -70), dtype=float)


def _support_words(
    target: np.ndarray, level: np.ndarray, baseline: np.ndarray, active: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    target = target + local_outlier_gain(level, baseline, active, _STEP)
    # Support softer words before breath protection, without flattening the whole performance.
    soft_word_lift = np.clip((baseline - level) * 0.15, 0.0, 2.0)
    return target + soft_word_lift, soft_word_lift


def _plan_targets(
    voice: Path,
    cancel: threading.Event,
    overlap: float,
    detected: tuple[np.ndarray, ...],
    reference: ReferenceLevels,
    report: dict[str, object],
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, bool]:
    times, level, music, meter_times, active, _ = detected
    contextual, has_body = _body_reference_balance(
        reference.balance, reference.body, reference.correction_db
    )
    body = _voiced_activity(voice, times, active, cancel)
    baseline, placement, reference_verified = _context_levels(
        times,
        level,
        active,
        overlap,
        contextual,
        reference.correction_db,
        voiced=body,
        paired_body=has_body,
    )
    report["placementLevelBasis"] = (
        "paired-voiced-body-context" if reference_verified and has_body else "momentary-reference"
    )
    target = _target_levels(times, level, music, meter_times, baseline, placement)
    placement_gain = target - level
    target, soft_word_lift = _support_words(target, level, baseline, active)
    return target, soft_word_lift, placement, placement_gain, body, reference_verified


def _build_gain_plan(
    renderer: MasterRenderer,
    voice: Path,
    backing: Path,
    overlap: float,
    cancel: threading.Event,
    *,
    reference: ReferenceLevels,
) -> tuple[GainPlan, np.ndarray]:
    detected = _detector(renderer, voice, backing, cancel)
    times, level, _, _, active, offset = detected
    report: dict[str, object] = {
        "method": "single-context-envelope",
        "activeSeconds": float(np.count_nonzero(active) * _STEP),
    }
    if not active.any():
        return GainPlan(times, np.zeros_like(level), active, level, offset, report), active
    target, lift, placement, placement_gain, body, verified = _plan_targets(
        voice, cancel, overlap, detected, reference, report
    )
    desired, protection = _protect_unvoiced(voice, times, target - level, active, cancel)
    # Include breath protection's attenuation when measuring the final vocal presence.
    presence_target = np.maximum(placement, -3.0 + 3.0 * overlap)
    presence = _presence_correction(
        voice, backing, times, desired, active, presence_target, cancel, verified
    )
    desired += presence + (0.0 if verified else 1.5)
    report["unvoicedProtection"] = protection
    global_gain = float(np.median(desired[active]))
    gains = _smoothed_gains(times, desired, active, global_gain, placement_gain)
    plan = GainPlan(times, gains, active, level + desired, offset, report, presence)
    plan.report_dynamics(lift, overlap, desired, verified)
    plan.report_automation(presence, placement, global_gain)
    return plan, body


def build_gain_plan(
    renderer: MasterRenderer,
    voice: Path,
    backing: Path,
    overlap: float,
    cancel: threading.Event,
    *,
    reference_balance: tuple[np.ndarray, np.ndarray, np.ndarray] | None = None,
    reference_level_correction_db: float | None = None,
    reference_presence: tuple[np.ndarray, np.ndarray, np.ndarray] | None = None,
    reference_body: ReferenceBody | None = None,
) -> GainPlan:
    plan, voiced = _build_gain_plan(
        renderer,
        voice,
        backing,
        overlap,
        cancel,
        reference=ReferenceLevels(reference_balance, reference_level_correction_db, reference_body),
    )
    if plan.report.get("balanceBasis") != "verified-source-reference":
        return replace(plan, clarity=plan.presence)
    clarity, bands = measure_reference_clarity(
        voice,
        backing,
        plan.times,
        plan.gains,
        voiced,
        reference_presence,
        reference_level_correction_db,
        cancel,
    )
    _check_cancel(cancel)
    return replace(plan, clarity=clarity, clarity_bands=bands)


def _smoothed_gains(
    times: np.ndarray,
    desired: np.ndarray,
    active: np.ndarray,
    global_gain: float,
    placement: np.ndarray,
) -> np.ndarray:
    correction = np.interp(times, times[active], (desired - placement)[active])
    gains = placement + correction_response(correction, _STEP)
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
