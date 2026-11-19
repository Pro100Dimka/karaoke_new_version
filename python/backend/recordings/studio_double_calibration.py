"""Measure own-voice double strength and preserve the complete vocal's placement."""

from collections.abc import Sequence
from contextlib import ExitStack
from dataclasses import dataclass, field
from pathlib import Path
import math
import threading

import numpy as np
import soundfile as sf

from backend.domain_errors import DependencyError
from backend.recordings.studio_audio import _check_cancel, _temporary_wave
from backend.recordings.studio_layer_types import VocalLayerRegion

_BLOCK = 32768


@dataclass
class _Region:
    start: float
    end: float
    target: float
    nominal: float
    scale: float = 1.0
    reason: str = ""
    capped: bool = False
    polarity: float = 1.0
    covariance: float = 0.0
    moments: np.ndarray = field(default_factory=lambda: np.zeros(7))
    measured: np.ndarray = field(default_factory=lambda: np.zeros(2))


@dataclass
class DoubleCalibration:
    path: Path
    regions: list[_Region]
    activity: tuple[np.ndarray, np.ndarray]
    mono: bool = False


@dataclass
class _Budget:
    start: float
    end: float
    gain: float = 1.0
    moments: np.ndarray = field(default_factory=lambda: np.zeros(4))
    measured: np.ndarray = field(default_factory=lambda: np.zeros(2))


def _regions(regions: Sequence[VocalLayerRegion]) -> list[_Region]:
    automatic = [r for r in regions if r.kind == "double" and r.target_side_to_mid_db is not None]
    result = []
    for start, end in sorted({(r.start, r.end) for r in automatic}):
        pair = [r for r in automatic if (r.start, r.end) == (start, end)]
        target = pair[0].target_side_to_mid_db
        assert target is not None
        group = _Region(start, end, target, max(r.gain for r in pair))
        if (
            len(pair) != 2
            or pair[0].pan * pair[1].pan >= 0
            or any(r.target_side_to_mid_db != target for r in pair)
        ):
            group.reason, group.scale = "unpaired-automatic-region", 0.0
        elif any(r not in pair and r.start < end and r.end > start for r in regions):
            group.reason = "overlapping-layer-regions"
        result.append(group)
    return result


def _mask(time: np.ndarray, region: _Region, activity: tuple[np.ndarray, np.ndarray]) -> np.ndarray:
    margin = min(0.08, (region.end - region.start) / 4)
    return np.asarray(
        (time >= region.start + margin)
        & (time < region.end - margin)
        & (np.interp(time, *activity, left=0, right=0) >= 0.95),
        dtype=bool,
    )


def _overlaps(time: np.ndarray, region: _Region | _Budget) -> bool:
    return bool(time[-1] >= region.start and time[0] < region.end)


def _mid_side(samples: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    return samples.mean(axis=1), (samples[:, 0] - samples[:, -1]) / 2


def _check_samples(*blocks: np.ndarray) -> None:
    if any(not np.isfinite(block).all() for block in blocks):
        raise DependencyError("StudioMasterInvalidAudio", "Vocal layers contain invalid samples")


def _measure_returns(
    finished: Path, wet: Path, plan: DoubleCalibration, cancel: threading.Event
) -> None:
    with sf.SoundFile(finished) as dry, sf.SoundFile(wet) as returned:
        for offset in range(0, dry.frames, _BLOCK):
            _check_cancel(cancel)
            original = dry.read(min(_BLOCK, dry.frames - offset), always_2d=True)
            added = returned.read(len(original), always_2d=True)
            _check_samples(original, added)
            dm, ds = _mid_side(original)
            wm, ws = _mid_side(added)
            time = (offset + np.arange(len(original))) / dry.samplerate
            values = np.column_stack((dm**2, ds**2, wm**2, ws**2, dm * wm, ds * ws))
            for region in plan.regions:
                if not _overlaps(time, region):
                    continue
                selected = _mask(time, region, plan.activity)
                region.moments[:6] += np.sum(values[selected], axis=0)
                region.moments[6] += np.count_nonzero(selected)
                full = (time >= region.start) & (time < region.end)
                region.covariance += float(np.sum(values[full, 4:6]))
    _check_cancel(cancel)


def _roots(coefficients: Sequence[float]) -> list[float]:
    roots = np.roots(np.trim_zeros(np.asarray(coefficients), "f"))
    return [float(root.real) for root in roots if abs(root.imag) < 1e-8 and root.real >= 0]


def _ratio(moments: np.ndarray, gain: float) -> float:
    dm, ds, wm, ws, cm, cs = moments[:6]
    return float(
        max(ds + 2 * gain * cs + gain**2 * ws, 1e-30)
        / max(dm + 2 * gain * cm + gain**2 * wm, 1e-30)
    )


def _fit_scale(region: _Region, rate: int) -> None:
    if region.reason:
        return
    if region.covariance < 0:
        region.polarity = -1.0
        region.moments[4:6] *= -1
    dm, ds, wm, ws, cm, cs, count = region.moments
    target, maximum = 10 ** (region.target / 10), 1 / region.nominal
    if count < rate * 0.06 or min(dm, wm + ws) <= count * 1e-18:
        region.reason, region.scale = "insufficient-voiced-source", 0.0
        return
    if ds >= target * dm:
        region.reason, region.scale = "existing-stereo-exceeds-target", 0.0
        return
    exact = _roots((ws - target * wm, 2 * (cs - target * cm), ds - target * dm))
    stationary = _roots((ws * cm - cs * wm, ws * dm - ds * wm, cs * dm - ds * cm))
    candidates = [0.0, maximum, *(x for x in exact + stationary if 0 <= x <= maximum)]
    region.scale = min(
        candidates, key=lambda x: (abs(math.log(_ratio(region.moments, x) / target)), x)
    )
    region.capped = not any(abs(region.scale - root) < 1e-6 for root in exact)


def _write_return(
    source: Path, target: Path, plan: DoubleCalibration, cancel: threading.Event
) -> None:
    with (
        sf.SoundFile(source) as audio,
        _temporary_wave(
            target, samplerate=sf.info(source).samplerate, channels=sf.info(source).channels
        ) as output,
    ):
        for offset in range(0, audio.frames, _BLOCK):
            _check_cancel(cancel)
            samples = audio.read(min(_BLOCK, audio.frames - offset), always_2d=True)
            time = (offset + np.arange(len(samples))) / audio.samplerate
            scales = np.ones(len(samples))
            for region in plan.regions:
                if not _overlaps(time, region):
                    continue
                selected = (time >= region.start) & (time < region.end)
                scales[selected] *= region.scale * region.polarity
            output.write(samples * scales[:, None])
    _check_cancel(cancel)


def calibrate_double_return(
    finished: Path,
    wet: Path,
    target: Path,
    regions: Sequence[VocalLayerRegion],
    activity: tuple[np.ndarray, np.ndarray],
    cancel: threading.Event,
) -> DoubleCalibration:
    """Fit one scalar per identifiable automatic pair; manual returns keep their gains."""
    _check_cancel(cancel)
    info = sf.info(finished)
    plan = DoubleCalibration(wet, _regions(regions), activity, info.channels == 1)
    if not plan.regions:
        return plan
    _measure_returns(finished, wet, plan, cancel)
    for region in plan.regions:
        if plan.mono:
            if not region.reason:
                region.polarity = -1.0 if region.covariance < 0 else 1.0
        else:
            _fit_scale(region, info.samplerate)
    _write_return(wet, target, plan, cancel)
    plan.path = target
    return plan


def _budgets(regions: Sequence[_Region]) -> list[_Budget]:
    result: list[_Budget] = []
    for region in sorted(regions, key=lambda r: (r.start, r.end)):
        if result and region.start <= result[-1].end:
            result[-1].end = max(result[-1].end, region.end)
        else:
            result.append(_Budget(region.start, region.end))
    return result


def _fade(time: np.ndarray, budget: _Budget) -> np.ndarray:
    duration = min(0.08, (budget.end - budget.start) / 4)
    weight = np.clip(np.minimum(time - budget.start, budget.end - time) / duration, 0, 1)
    return weight * weight * (3 - 2 * weight)


def _blocks(
    stack: ExitStack, finished: Path, paths: Sequence[Path]
) -> tuple[sf.SoundFile, list[sf.SoundFile]]:
    return stack.enter_context(sf.SoundFile(finished)), [
        stack.enter_context(sf.SoundFile(path)) for path in paths
    ]


def _combined(dry: np.ndarray, sources: Sequence[sf.SoundFile], gain: float) -> np.ndarray:
    wet = np.zeros_like(dry)
    for source in sources:
        wet += source.read(len(dry), always_2d=True)
    _check_samples(dry, wet)
    return np.asarray(dry + gain * wet, dtype=float)


def _measure_budgets(
    finished: Path,
    paths: Sequence[Path],
    gain: float,
    budgets: list[_Budget],
    cancel: threading.Event,
) -> None:
    with ExitStack() as stack:
        audio, sources = _blocks(stack, finished, paths)
        for offset in range(0, audio.frames, _BLOCK):
            _check_cancel(cancel)
            dry = audio.read(min(_BLOCK, audio.frames - offset), always_2d=True)
            combined = _combined(dry, sources, gain)
            time = (offset + np.arange(len(dry))) / audio.samplerate
            power, original = np.mean(combined**2, axis=1), np.mean(dry**2, axis=1)
            for budget in budgets:
                if not _overlaps(time, budget):
                    continue
                selected = (time >= budget.start) & (time < budget.end)
                p, w = power[selected], _fade(time[selected], budget)
                budget.moments += [
                    np.sum(original[selected]),
                    np.sum(p),
                    np.sum(w * p),
                    np.sum(w**2 * p),
                ]
    _check_cancel(cancel)


def _budget_gain(budget: _Budget) -> float:
    original, combined, first, second = budget.moments
    excess = combined - original
    if excess <= 0 or second <= 1e-30:
        return 1.0
    discriminant = max(first**2 - second * excess, 0.0)
    delta = -excess / max(first + math.sqrt(discriminant), 1e-30)
    # An equal-amplitude parallel return never warrants more than 6 dB of trim.
    return float(np.clip(1 + delta, 0.5, 1.0))


def _measure_output(
    original: np.ndarray,
    output: np.ndarray,
    time: np.ndarray,
    plan: DoubleCalibration,
    budgets: list[_Budget],
) -> None:
    mid, side = _mid_side(output)
    for region in plan.regions:
        if not _overlaps(time, region):
            continue
        selected = _mask(time, region, plan.activity)
        region.measured += [np.sum(mid[selected] ** 2), np.sum(side[selected] ** 2)]
    for budget in budgets:
        if not _overlaps(time, budget):
            continue
        selected = (time >= budget.start) & (time < budget.end)
        budget.measured += [np.sum(original[selected] ** 2), np.sum(output[selected] ** 2)]


def _write_mix(
    finished: Path,
    paths: Sequence[Path],
    target: Path,
    gain: float,
    plan: DoubleCalibration,
    budgets: list[_Budget],
    cancel: threading.Event,
) -> None:
    with ExitStack() as stack:
        audio, sources = _blocks(stack, finished, paths)
        output = stack.enter_context(
            _temporary_wave(target, samplerate=audio.samplerate, channels=audio.channels)
        )
        for offset in range(0, audio.frames, _BLOCK):
            _check_cancel(cancel)
            original = audio.read(min(_BLOCK, audio.frames - offset), always_2d=True)
            combined = _combined(original, sources, gain)
            time = (offset + np.arange(len(original))) / audio.samplerate
            envelope = np.ones(len(original))
            for budget in budgets:
                if _overlaps(time, budget):
                    envelope *= 1 + (budget.gain - 1) * _fade(time, budget)
            combined *= envelope[:, None]
            _measure_output(original, combined, time, plan, budgets)
            output.write(combined)
    _check_cancel(cancel)


def _region_report(region: _Region, gain: float, mono: bool) -> dict[str, object]:
    mid, side = region.measured if region.measured.any() else region.moments[:2]
    actual = 10 * math.log10(max(side, 1e-30) / mid) if not mono and mid > 1e-20 else None
    return {
        "start": region.start,
        "end": region.end,
        "targetSideToMidDb": region.target,
        "actualSideToMidDb": actual,
        "returnGainScale": region.scale,
        "returnPolarity": region.polarity,
        "maxLayerGain": min(1.0, region.nominal * region.scale * gain),
        "capped": region.capped or gain < 1,
        "targetUnreached": actual is None or abs(actual - region.target) > 1,
        "reason": region.reason
        or ("mono-spatial-fit-unavailable" if mono else "measured-return-fit"),
    }


def calibration_report(plan: DoubleCalibration, gain: float = 1.0) -> dict[str, object]:
    return {
        "applied": any(not region.reason and region.scale > 0 for region in plan.regions)
        and not plan.mono,
        "method": "measured-own-return-and-regional-vocal-budget",
        "reason": "mono-spatial-fit-unavailable" if plan.mono else "measured-stereo-return",
        "regions": [_region_report(region, gain, plan.mono) for region in plan.regions],
    }


def sum_with_double_budget(
    finished: Path,
    paths: Sequence[Path],
    target: Path,
    gain: float,
    plan: DoubleCalibration,
    cancel: threading.Event,
) -> dict[str, object]:
    budgets = _budgets(plan.regions)
    _measure_budgets(finished, paths, gain, budgets, cancel)
    for budget in budgets:
        budget.gain = _budget_gain(budget)
    _write_mix(finished, paths, target, gain, plan, budgets, cancel)
    report = calibration_report(plan, gain)
    report["vocalBudgets"] = [
        {
            "start": budget.start,
            "end": budget.end,
            "gainDb": 20 * math.log10(budget.gain),
            "levelChangeDb": 10
            * math.log10(max(budget.measured[1], 1e-30) / max(budget.measured[0], 1e-30)),
        }
        for budget in budgets
    ]
    return {
        "doublingCalibration": report,
        "dryPreserved": all(budget.gain == 1 for budget in budgets),
        "drySignalPreservedUpToRegionalGain": True,
    }
