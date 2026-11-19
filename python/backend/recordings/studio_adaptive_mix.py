"""One adaptive balance plan, spectral room for the lead, sends, and master delivery."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
import math
import shutil
import threading
import time

import numpy as np
import soundfile as sf
from scipy.ndimage import gaussian_filter1d
from scipy.signal import sosfilt

from backend.domain_errors import DependencyError
from backend.recordings.studio_audio import (
    MasterRenderer,
    _check_cancel,
    _profile,
    _temporary_wave,
    _write_gain_envelope,
)
from backend.recordings.studio_adaptive_balance import (
    plan_balance as plan_balance,
    measure_balance,
    vocal_activity as _activity,
)
from backend.recordings.studio_adaptive_delivery import deliver_master
from backend.recordings.studio_adaptive_space import render_sends
from backend.recordings.studio_arrangement import ArrangementMap, analyze_arrangement
from backend.recordings.studio_section_balance import plan_section_balance
from backend.recordings.studio_mix_audit import audit_mix

_STEP = 0.1


def _peaking(rate: int, frequency: float, db: float = -3.0) -> np.ndarray:
    a = 10 ** (db / 40)
    omega = 2 * math.pi * frequency / rate
    alpha = math.sin(omega) / (2 * 1.0)
    coefficients = np.array(
        [
            1 + alpha * a,
            -2 * math.cos(omega),
            1 - alpha * a,
            1 + alpha / a,
            -2 * math.cos(omega),
            1 - alpha / a,
        ]
    )
    coefficients /= coefficients[3]
    return coefficients[None, :]


@dataclass(frozen=True, slots=True)
class DuckPlan:
    frequency: float
    reduction: np.ndarray
    before_band: np.ndarray
    eligible: np.ndarray
    band_hz: tuple[float, float]
    band_support: dict[str, object]


def _duck_frequency(
    vocal: Path,
    backing: Path,
    voice: np.ndarray,
    music: np.ndarray,
    eligible: np.ndarray,
    high: float,
    cancel: threading.Event,
) -> float:
    weights, centers = [], []
    for begin, end in ((1500.0, 2000.0), (2000.0, 2700.0), (2700.0, high)):
        if end <= begin:
            continue
        v = _profile(vocal, cancel, voice_band=True, band_hz=(begin, end))
        b = _profile(backing, cancel, voice_band=True, band_hz=(begin, end))
        relative = v[eligible] - voice[eligible] + b[eligible] - music[eligible]
        weights.append(float(np.mean(10 ** (relative / 20))))
        centers.append(math.sqrt(begin * end))
    return float(np.average(centers, weights=weights)) if sum(weights) > 1e-12 else 2300.0


def _vocal_band_support(
    voice: np.ndarray, band: np.ndarray, active: np.ndarray
) -> tuple[np.ndarray, dict[str, object]]:
    quiet = (
        voice < float(np.median(voice[active])) - 24
        if active.any()
        else np.zeros(len(voice), dtype=bool)
    )
    noise = float(np.percentile(band[quiet], 90)) if np.count_nonzero(quiet) >= 3 else None
    # A dark vowel's strong fundamental must not disqualify audible upper harmonics.
    # Compare the band with its own quiet noise; retain the old guard without evidence.
    supported = band - voice > -15 if noise is None else band - noise >= 8
    return supported, {
        "method": "relative-band-fallback" if noise is None else "quiet-band-signal-to-noise",
        "estimatedNoiseFloorDbfs": noise,
        "minimumSignalToNoiseDb": 8.0 if noise is not None else None,
        "minimumRelativeBandDb": -15.0 if noise is None else None,
        "quietIntervalSeconds": float(np.count_nonzero(quiet) * _STEP),
    }


def _duck_plan(vocal: Path, backing: Path, cancel: threading.Event) -> DuckPlan | None:
    low, high = 1500.0, min(3500.0, sf.info(backing).samplerate * 0.45)
    if high <= low:
        return None
    voice, music = _profile(vocal, cancel), _profile(backing, cancel)
    vband = _profile(vocal, cancel, voice_band=True, band_hz=(low, high))
    bband = _profile(backing, cancel, voice_band=True, band_hz=(low, high))
    active = _activity(voice)
    supported, evidence = _vocal_band_support(voice, vband, active)
    eligible = active & _activity(music) & supported & (bband - music > -18)
    if not eligible.any():
        return None
    center = _duck_frequency(vocal, backing, voice, music, eligible, high, cancel)
    requested = np.where(eligible, np.clip((bband - vband + 6) * 0.3, 0, 3), 0.0)
    reduction = gaussian_filter1d(requested, sigma=1.0, mode="constant")
    reduction[~active] = 0
    return DuckPlan(center, reduction, bband, eligible, (low, high), evidence)


def _write_duck(backing: Path, target: Path, plan: DuckPlan, cancel: threading.Event) -> None:
    info = sf.info(backing)
    amount = (1 - 10 ** (-plan.reduction / 20)) / (1 - 10 ** (-3 / 20))
    times = (np.arange(len(amount)) + 0.5) * _STEP
    coefficients = _peaking(info.samplerate, plan.frequency)
    state, offset = np.zeros((1, 2, info.channels)), 0
    with (
        sf.SoundFile(backing) as source,
        _temporary_wave(target, samplerate=info.samplerate, channels=info.channels) as output,
    ):
        for block in source.blocks(blocksize=65536, dtype="float32", always_2d=True):
            _check_cancel(cancel)
            equalized, state = sosfilt(coefficients, block, axis=0, zi=state)
            positions = (offset + np.arange(len(block))) / info.samplerate
            blend = np.interp(positions, times, amount)[:, None]
            output.write(block + blend * (equalized - block))
            offset += len(block)


def duck_backing(
    vocal: Path, backing: Path, target: Path, cancel: threading.Event
) -> dict[str, object]:
    plan = _duck_plan(vocal, backing, cancel)
    if plan is None:
        shutil.copyfile(backing, target)
        return {
            "applied": False,
            "maxReductionDb": 0.0,
            "method": "vocal-keyed-dynamic-peaking-eq",
            "reason": "no-supported-spectral-conflict",
        }
    _write_duck(backing, target, plan, cancel)
    after = _profile(target, cancel, voice_band=True, band_hz=plan.band_hz)
    measured = plan.before_band[plan.eligible] - after[plan.eligible]
    return {
        "applied": bool(np.max(plan.reduction) > 0.01),
        "method": "vocal-keyed-dynamic-peaking-eq",
        "frequencyHz": plan.frequency,
        "q": 1.0,
        "maxReductionDb": float(np.max(plan.reduction, initial=0)),
        "medianMeasuredBandReductionDb": float(np.median(measured)),
        "activeSeconds": float(np.count_nonzero(plan.reduction > 0.05) * _STEP),
        "stereoLinked": True,
        "inactiveBackingPreserved": True,
        "vocalBandSupport": plan.band_support,
    }


def _validate_formats(vocal: Path, backing: Path) -> sf._SoundFileInfo:
    info, music = sf.info(vocal), sf.info(backing)
    if (info.frames, info.samplerate, info.channels) != (
        music.frames,
        music.samplerate,
        music.channels,
    ):
        raise DependencyError("StudioMasterStemMismatch", "Mastering stems are not synchronized")
    if info.frames <= 0:
        raise DependencyError("StudioMasterInvalidAudio", "Recording is empty")
    return info


@dataclass(frozen=True, slots=True)
class MixInputs:
    vocal: Path
    backing: Path
    reference_vocal: Path | None
    reference_backing: Path | None
    original_mix: Path | None
    recorded_is_dry: bool
    arrangement: ArrangementMap


def _sum_stems(
    renderer: MasterRenderer, first: Path, second: Path, target: Path, cancel: threading.Event
) -> None:
    renderer._mix(
        first,
        second,
        "[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[out]",
        ["-c:a", "pcm_f32le", str(target)],
        cancel,
    )


def _reference_mix(
    renderer: MasterRenderer, inputs: MixInputs, work: Path, cancel: threading.Event
) -> Path | None:
    if inputs.original_mix is not None:
        return inputs.original_mix
    if inputs.reference_vocal is None or inputs.reference_backing is None:
        return None
    target = work / "reference.wav"
    _sum_stems(renderer, inputs.reference_vocal, inputs.reference_backing, target, cancel)
    return target


def _mix_stages(
    renderer: MasterRenderer,
    inputs: MixInputs,
    work: Path,
    cancel: threading.Event,
    progress: Callable[[str, float, float], None] | None,
) -> dict[str, object]:
    started = time.perf_counter()
    plan = plan_section_balance(
        inputs.vocal,
        inputs.backing,
        inputs.reference_vocal,
        inputs.reference_backing,
        inputs.arrangement,
        cancel,
    )
    balanced, music, spatial = work / "balanced.wav", work / "backing.wav", work / "spatial.wav"
    _write_gain_envelope(inputs.vocal, balanced, plan.times, plan.gains, cancel)
    balance_seconds = time.perf_counter() - started
    duck = duck_backing(balanced, inputs.backing, music, cancel)
    plan.report.update(measure_balance(plan, balanced, music, cancel))
    if progress:
        progress("MixingStudioMaster", 0.55, 0.84)
    effects = render_sends(
        balanced,
        music,
        spatial,
        cancel,
        reference=inputs.reference_vocal,
        recorded_is_dry=inputs.recorded_is_dry,
        arrangement=inputs.arrangement,
    )
    _sum_stems(renderer, spatial, music, work / "mix.wav", cancel)
    return {
        "balance": plan.report,
        "backingEq": duck,
        "space": effects,
        "arrangement": inputs.arrangement.payload(),
        "timingsSeconds": {"balance": balance_seconds},
    }


def mix_and_master(
    renderer: MasterRenderer,
    vocal: Path,
    backing: Path,
    target: Path,
    cancel: threading.Event,
    *,
    reference_vocal: Path | None = None,
    reference_backing: Path | None = None,
    original_mix: Path | None = None,
    recorded_is_dry: bool = True,
    arrangement: ArrangementMap | None = None,
    progress: Callable[[str, float, float], None] | None = None,
) -> dict[str, object]:
    _check_cancel(cancel)
    info = _validate_formats(vocal, backing)
    context = arrangement or analyze_arrangement(backing, reference_vocal, cancel)
    if (context.frames, context.rate) != (info.frames, info.samplerate):
        raise DependencyError("StudioMasterStemMismatch", "Arrangement must cover the mix timeline")
    target.parent.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    inputs = MixInputs(
        vocal, backing, reference_vocal, reference_backing, original_mix, recorded_is_dry, context
    )
    with TemporaryDirectory(prefix=".adaptive-mix-", dir=target.parent) as directory:
        work = Path(directory)
        report = _mix_stages(renderer, inputs, work, cancel, progress)
        reference = _reference_mix(renderer, inputs, work, cancel)
        if progress:
            progress("MasteringRecording", 0.0, 0.87)
        delivery_started = time.perf_counter()
        report["delivery"] = deliver_master(
            renderer, work / "mix.wav", target, cancel, reference=reference
        )
        report["postMixAudit"] = audit_mix(work / "spatial.wav", work / "backing.wav", target)
    return _completed_mix_report(report, started, delivery_started)


def _completed_mix_report(
    report: dict[str, object], started: float, delivery_started: float
) -> dict[str, object]:
    report["order"] = [
        "sectionBalance",
        "dynamicBackingEq",
        "parallelSpaceSends",
        "masterGlue",
        "truePeakLimiter",
    ]
    timing = report["timingsSeconds"]
    if isinstance(timing, dict):
        timing.update(
            delivery=time.perf_counter() - delivery_started, total=time.perf_counter() - started
        )
    _delivered_noise_estimate(report)
    return report


def _delivered_noise_estimate(report: dict[str, object]) -> None:
    balance, delivery = report.get("balance"), report.get("delivery")
    if not isinstance(balance, dict) or not isinstance(delivery, dict):
        return
    evidence = balance.get("calibrationEvidence")
    if not isinstance(evidence, dict):
        return
    before = evidence.get("estimatedPreMasterDryVocalNoiseDbfs")
    gain = delivery.get("globalGainDb")
    if isinstance(before, (float, int)) and isinstance(gain, (float, int)):
        evidence.update(
            estimatedDeliveredDryVocalNoiseDbfs=before + gain,
            deliveryGainDb=gain,
            deliveryEstimateScope="dry-vocal quiet-floor estimate plus maximum vocal and common "
            "master gain; excludes FX returns and additional glue/limiter attenuation",
        )
