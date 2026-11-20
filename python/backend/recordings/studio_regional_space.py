"""Evidence-led regional ambience with a unity dry path and mono-compatible returns."""

from __future__ import annotations

from contextlib import ExitStack
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
import math
import shutil
import threading

import numpy as np
import soundfile as sf

from backend.domain_errors import DependencyError
from backend.recordings.studio_arrangement import ArrangementMap
from backend.recordings.studio_audio import _check_cancel, _temporary_wave
from backend.recordings.studio_regional_evidence import (
    _global_priors,
    _section_evidence,
    _valid_intervals,
    coherent_pan as _coherent_pan,
    envelope_relatedness as _local_relatedness,
    exclude_instantaneous_pan,
)
from backend.recordings.studio_space_analysis import _field_envelopes
from backend.recordings.studio_regional_returns import (
    AmbienceRegion,
    EchoRegion,
    _impulse,
    convolve_return,
)
from backend.recordings.studio_coherent_echo import (
    echo_buses,
    plan_coherent_echoes,
    without_echo_regions,
)


def _candidate_region(
    start: float,
    end: float,
    reference: np.ndarray,
    existing: np.ndarray,
    priors: list[tuple[np.ndarray, float] | None],
) -> AmbienceRegion | None:
    candidates = []
    section = slice(round(start * 50), round(end * 50))
    # Low-band stereo energy alone can be a harmonic or a backing singer.
    # Keep that legacy side-only evidence separate from a new mono room return.
    for index, band in ((1, (500, 3500)),):
        values = reference[section, index]
        evidence = _section_evidence(values, priors[index])
        if evidence is None:
            continue
        kernel, score, method = evidence
        observed = float(values[:, 1].sum() / max(values[:, 0].sum(), 1e-20))
        ratio = min(float(kernel.sum()), observed, 0.35)
        current = existing[section, index]
        present = float(current[:, 1].sum() / max(current[:, 0].sum(), 1e-20))
        if ratio < 1e-4:
            continue
        region = AmbienceRegion(start, end, kernel, band, index, ratio, present, score, method)
        candidates.append((score * values[:, 1].sum(), region))
    return max(candidates, key=lambda item: item[0])[1] if candidates else None


def _repeat_contexts(
    arrangement: ArrangementMap,
    regions: list[AmbienceRegion],
    expected: np.ndarray,
    existing: np.ndarray,
) -> list[AmbienceRegion]:
    groups: dict[int, list[AmbienceRegion]] = {}
    for section in arrangement.sections:
        group = getattr(section, "repeat_group", None)
        if group is not None:
            groups.setdefault(group, []).extend(
                r for r in regions if section.start_seconds <= r.start < section.end_seconds
            )
    additions = []
    for section in arrangement.sections:
        group = getattr(section, "repeat_group", None)
        peers = groups.get(group, []) if group is not None else []
        if not peers:
            continue
        peer = max(peers, key=lambda region: region.confidence)
        for bounds in _valid_intervals(section.start_seconds, section.end_seconds, arrangement):
            if _is_covered(bounds, regions):
                continue
            candidate = _candidate_region(
                *bounds, expected, existing, [None, (peer.kernel, peer.confidence)]
            )
            if candidate is not None:
                additions.append(replace(candidate, response_source=(peer.start, peer.end)))
    return additions


def _is_covered(bounds: tuple[float, float], regions: list[AmbienceRegion]) -> bool:
    return any(
        region.start <= bounds[0] + 1e-6 and region.end >= bounds[1] - 1e-6 for region in regions
    )


def _context_region(
    bounds: tuple[float, float],
    expected: np.ndarray,
    existing: np.ndarray,
    prior: tuple[np.ndarray, float],
) -> AmbienceRegion | None:
    start, end = bounds
    section = slice(round(start * 50), round(end * 50))
    values, current = expected[section, 1], existing[section, 1]
    if _local_relatedness(values) <= 0:
        return None
    observed = float(values[:, 1].sum() / max(values[:, 0].sum(), 1e-20))
    ratio = min(observed, float(prior[0].sum()) * 0.5, 0.35)
    if ratio < 1e-4:
        return None
    present = float(current[:, 1].sum() / max(current[:, 0].sum(), 1e-20))
    return AmbienceRegion(
        start,
        end,
        prior[0],
        (500, 3500),
        1,
        ratio,
        present,
        prior[1],
        "qualified-global-response-with-local-relatedness-and-bounded-level",
        (0.0, len(expected) * 0.02),
        False,
        "whole-recording-context",
    )


def _context_fallbacks(
    reference: Path,
    arrangement: ArrangementMap,
    regions: list[AmbienceRegion],
    expected: np.ndarray,
    existing: np.ndarray,
    prior: tuple[np.ndarray, float] | None,
    cancel: threading.Event,
) -> list[AmbienceRegion]:
    if prior is None:
        return []
    additions = []
    for section in arrangement.sections:
        for bounds in _valid_intervals(section.start_seconds, section.end_seconds, arrangement):
            if _is_covered(bounds, regions):
                continue
            candidate = _context_region(bounds, expected, existing, prior)
            if candidate is not None and not _coherent_pan(reference, *bounds, cancel):
                additions.append(candidate)
    return additions


def plan_regional_ambience(
    voice: Path, reference: Path | None, arrangement: ArrangementMap, cancel: threading.Event
) -> list[AmbienceRegion]:
    _check_cancel(cancel)
    info = sf.info(voice)
    if info.frames != arrangement.frames or info.samplerate != arrangement.rate:
        raise DependencyError(
            "StudioMasterStemMismatch", "Arrangement must cover the vocal timeline"
        )
    if reference is None or info.samplerate <= 7000 or info.channels != 2:
        return []
    expected = _field_envelopes(reference, cancel)
    existing = exclude_instantaneous_pan(
        voice, _field_envelopes(voice, cancel), arrangement, cancel
    )
    if len(expected) < 300 or not len(existing):
        return []
    priors = _global_priors(expected, arrangement)
    reference_end = sf.info(reference).duration
    regions = []
    for section in arrangement.sections:
        _check_cancel(cancel)
        end = min(section.end_seconds, reference_end, info.duration)
        for start, end in _valid_intervals(section.start_seconds, end, arrangement):
            region = _candidate_region(start, end, expected, existing, priors)
            if region is not None:
                regions.append(region)
    regions.extend(_repeat_contexts(arrangement, regions, expected, existing))
    regions.extend(
        _context_fallbacks(reference, arrangement, regions, expected, existing, priors[1], cancel)
    )
    return _reference_bounds(sorted(regions, key=lambda region: region.start), arrangement)


def _reference_bounds(
    regions: list[AmbienceRegion], arrangement: ArrangementMap
) -> list[AmbienceRegion]:
    intervals = _valid_intervals(0, arrangement.duration_seconds, arrangement)
    result = []
    for region in regions:
        start, end = next(
            (
                bounds
                for bounds in intervals
                if bounds[0] <= region.start and bounds[1] >= region.end
            ),
            (region.start, region.end),
        )
        result.append(replace(region, valid_start=start, valid_end=end))
    return result


def _calibrate_region(
    voice_energy: np.ndarray,
    path: Path,
    region: AmbienceRegion,
    existing_wet: float,
    added_energy: np.ndarray,
    cancel: threading.Event,
) -> tuple[float, float]:
    wet = _field_envelopes(path, cancel, band_index=region.band_index)
    section = slice(round(region.start * 50), round(region.end * 50))
    dry_mid = float(voice_energy[section, region.band_index, 0].sum())
    wet_mid, wet_side = wet[section, 0].sum(axis=0)
    missing = max(0, region.ratio - region.existing_ratio)
    missing_side = max(0, missing * dry_mid - added_energy[section, region.band_index, 1].sum())
    missing_mid = max(0, min(missing, 0.35**2) - existing_wet**2)
    return (
        math.sqrt(missing_mid * dry_mid / max(float(wet_mid), 1e-20)),
        math.sqrt(missing_side / max(float(wet_side), 1e-20)),
    )


def _added_field_energy(
    legacy: list[tuple[str, Path, float]], template: np.ndarray, cancel: threading.Event
) -> np.ndarray:
    energy = np.zeros_like(template)
    for _, path, gain in legacy:
        energy += _field_envelopes(path, cancel) * gain**2
    return energy


def _regional_buses(
    voice: Path,
    work: Path,
    regions: list[AmbienceRegion],
    existing_wet: float,
    legacy: list[tuple[str, Path, float]],
    cancel: threading.Event,
) -> tuple[list[tuple[str, Path, float, float]], list[dict[str, object]]]:
    voice_energy = _field_envelopes(voice, cancel)
    added_energy = _added_field_energy(legacy, voice_energy, cancel)
    buses, reports = [], []
    for index, region in enumerate(regions):
        if region.ratio <= region.existing_ratio * (1 + 1e-6):
            reports.append(
                {
                    **region.payload(),
                    "midSendGain": 0.0,
                    "sideSendGain": 0.0,
                    "decision": "already-present",
                }
            )
            continue
        path = work / f"ambience-{index}.wav"
        convolve_return(voice, path, region, _impulse(region, sf.info(voice).samplerate), cancel)
        mid, side = _calibrate_region(
            voice_energy, path, region, existing_wet, added_energy, cancel
        )
        buses.append(("regional-ambience", path, mid, side))
        reports.append(
            {
                **region.payload(),
                "midSendGain": mid,
                "sideSendGain": side,
                "existingAndAddedMonoWetRatioBound": existing_wet,
                "legacySideEnergyAccounted": bool(legacy),
                "decision": "estimated-addition",
            }
        )
    return buses, reports


def _read_regional(
    readers: list[tuple[str, sf.SoundFile, float, float]], count: int
) -> dict[str, np.ndarray]:
    result: dict[str, np.ndarray] = {}
    for name, reader, mid_gain, side_gain in readers:
        block = reader.read(count, always_2d=True)
        mid = block.mean(axis=1) * mid_gain
        side = (block[:, 0] - block[:, 1]) * 0.5 * side_gain
        result.setdefault(name, np.zeros((count, 2)))
        result[name] += np.column_stack((mid + side, mid - side))
    return result


def _wet_block(
    rooms: list[tuple[str, sf.SoundFile, float, float]],
    legacy: list[tuple[str, sf.SoundFile, float]],
    ducking: np.ndarray,
    energies: dict[str, float],
    mono_energies: dict[str, float],
    channels: int,
) -> np.ndarray:
    returns = _read_regional(rooms, len(ducking))
    for name, reader, gain in legacy:
        added = reader.read(len(ducking), always_2d=True) * gain * ducking
        returns[name] = returns.get(name, np.zeros_like(added)) + added
    wet = np.zeros((len(ducking), channels))
    for name, added in returns.items():
        wet += added
        energies[name] = energies.get(name, 0.0) + float(np.sum(added**2))
        mono_energies[name] = mono_energies.get(name, 0.0) + float(np.sum(added.mean(axis=1) ** 2))
    return wet


def _mix_buses(
    voice: Path,
    target: Path,
    regional: list[tuple[str, Path, float, float]],
    legacy: list[tuple[str, Path, float]],
    cancel: threading.Event,
    legacy_duck: Callable[[np.ndarray], np.ndarray],
) -> tuple[dict[str, float], float, float, dict[str, float]]:
    info = sf.info(voice)
    energies: dict[str, float] = {}
    mono_energies: dict[str, float] = {}
    dry_energy = dry_mono_energy = 0.0
    with ExitStack() as stack:
        source = stack.enter_context(sf.SoundFile(voice))
        rooms = [
            (name, stack.enter_context(sf.SoundFile(path)), mid, side)
            for name, path, mid, side in regional
        ]
        old = [(name, stack.enter_context(sf.SoundFile(path)), gain) for name, path, gain in legacy]
        output = stack.enter_context(
            _temporary_wave(target, samplerate=info.samplerate, channels=info.channels)
        )
        for block in source.blocks(blocksize=32768, always_2d=True):
            _check_cancel(cancel)
            wet = _wet_block(rooms, old, legacy_duck(block), energies, mono_energies, info.channels)
            dry_energy += float(np.sum(block**2))
            dry_mono_energy += float(np.sum(block.mean(axis=1) ** 2))
            output.write(block + wet)
    return energies, dry_energy, dry_mono_energy, mono_energies


def _report(
    base: dict[str, object],
    regions: list[dict[str, object]],
    energies: dict[str, float],
    dry: float,
    dry_mono: float,
    wet_mono: dict[str, float],
) -> dict[str, object]:
    buses = {
        name: {"wetToDryDb": 10 * math.log10(max(value, 1e-30) / max(dry, 1e-30))}
        for name, value in energies.items()
        if value > 1e-20
    }
    for name in buses:
        buses[name]["monoWetToDryDb"] = 10 * math.log10(
            max(wet_mono.get(name, 0.0), 1e-30) / max(dry_mono, 1e-30)
        )
    return {
        **base,
        "method": "regional-mono-compatible-ambience-and-supported-sends",
        "dryPathUnity": True,
        "applied": bool(buses),
        "ambienceRegions": regions,
        "status": "no-supported-addition"
        if not buses
        else "estimated-reference-ambience"
        if "regional-ambience" in buses
        else "measured-reference-effects",
        "regionalWetLevelPolicy": "constant-per-region-with-250ms-input-crossfades-and-continuous-tails",
        "ambienceCaveat": "Delayed stereo evidence supports an ambience estimate; wet-mid energy and the original effect identity are not separately identifiable.",
        "buses": buses,
    }


def _coverage(
    regions: list[AmbienceRegion], echoes: list[EchoRegion], duration: float
) -> dict[str, object]:
    cursor = 0.0
    unresolved = []
    covered: list[AmbienceRegion | EchoRegion] = [*regions, *echoes]
    for region in sorted(covered, key=lambda region: region.start):
        if region.start > cursor:
            unresolved.append([cursor, region.start])
        cursor = max(cursor, region.end)
    if cursor < duration:
        unresolved.append([cursor, duration])
    return {
        "localFitSeconds": sum(r.end - r.start for r in regions if r.local_fit),
        "contextEstimatedSeconds": sum(r.end - r.start for r in regions if not r.local_fit),
        "coherentEchoSeconds": sum(r.end - r.start for r in echoes),
        "unresolvedIntervals": unresolved,
        "uncertainty": "Context estimates are bounded production choices, not independent local effect identification.",
    }


def render_regional_sends(
    voice: Path,
    target: Path,
    cancel: threading.Event,
    *,
    reference: Path | None,
    arrangement: ArrangementMap,
    base_report: dict[str, object],
    legacy: list[tuple[str, Path, float]],
    existing_wet: float,
    legacy_duck: Callable[[np.ndarray], np.ndarray],
) -> dict[str, object]:
    echoes = (
        []
        if any(name == "delay" for name, _, _ in legacy)
        else plan_coherent_echoes(voice, reference, arrangement, cancel)
    )
    regions = plan_regional_ambience(voice, reference, arrangement, cancel)
    regions = without_echo_regions(regions, echoes)
    base_report = {
        **base_report,
        "ambienceEvidenceCoverage": _coverage(regions, echoes, arrangement.duration_seconds),
    }
    with TemporaryDirectory(prefix=".regional-sends-", dir=target.parent) as directory:
        work = Path(directory)
        rooms, reports = _regional_buses(voice, work, regions, existing_wet, legacy, cancel)
        copies, copy_reports = echo_buses(voice, work, echoes, cancel)
        base_report["coherentEchoRegions"] = copy_reports
        rooms.extend(copies)
        if not rooms and not legacy:
            shutil.copyfile(voice, target)
            return _report(base_report, reports, {}, 0, 0, {})
        energy, dry, dry_mono, wet_mono = _mix_buses(
            voice, target, rooms, legacy, cancel, legacy_duck
        )
    return _report(base_report, reports, energy, dry, dry_mono, wet_mono)
