"""Evidence-led regional ambience with a unity dry path and mono-compatible returns."""

from __future__ import annotations

from contextlib import ExitStack
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from functools import partial
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
from backend.recordings.studio_parallel import ordered_map
from backend.recordings.studio_regional_evidence import exclude_instantaneous_pan
from backend.recordings.studio_reference_ambience import (
    ReferenceAmbience,
    _candidate_region as _candidate_region,
    _context_region as _context_region,
    _local_relatedness as _local_relatedness,
    bind_existing_ambience,
    fit_reference_ambience,
)
from backend.recordings.studio_space_analysis import _field_envelopes
from backend.recordings.studio_regional_returns import (
    AmbienceRegion,
    EchoRegion,
    _coverage,
    _impulse,
    convolve_return,
)
from backend.recordings.studio_return_audio import (
    RegionalReader,
    ReturnSpan,
    convolve_compact_return,
    read_regional as _read_regional,
)
from backend.recordings.studio_regional_levels import (
    RegionalFields,
    _added_field_energy,
    _calibrate_region,
)
from backend.recordings.studio_coherent_echo import (
    echo_buses,
    plan_coherent_echoes,
    without_echo_regions,
)

RegionalBus = tuple[str, Path, float, float]
RegionalResult = tuple[RegionalBus | None, dict[str, object], ReturnSpan | None]


def plan_regional_ambience(
    voice: Path,
    reference: Path | None,
    arrangement: ArrangementMap,
    cancel: threading.Event,
    *,
    fields: RegionalFields | None = None,
    ambience: ReferenceAmbience | None = None,
) -> list[AmbienceRegion]:
    _check_cancel(cancel)
    info = sf.info(voice)
    if info.frames != arrangement.frames or info.samplerate != arrangement.rate:
        raise DependencyError(
            "StudioMasterStemMismatch", "Arrangement must cover the vocal timeline"
        )
    if reference is None or info.samplerate <= 7000 or info.channels != 2:
        return []
    measured = fields or RegionalFields()
    expected = None
    if ambience is None:
        expected, raw = measured.measure_pair(voice, reference, cancel)
    else:
        ambience.validate(reference, arrangement, cancel)
        raw = measured.measure_voice(voice, cancel)
    existing = exclude_instantaneous_pan(voice, raw, arrangement, cancel)
    if not len(existing):
        return []
    if ambience is not None:
        return bind_existing_ambience(ambience.regions, existing)
    assert expected is not None
    regions = fit_reference_ambience(reference, arrangement, expected, cancel)
    return bind_existing_ambience(regions, existing)


@dataclass(frozen=True, slots=True)
class _RegionalContext:
    voice: Path
    work: Path
    voice_energy: np.ndarray
    added_energy: np.ndarray
    existing_wet: float
    legacy_present: bool
    rate: int
    cancel: threading.Event
    compact: bool


def _regional_bus(context: _RegionalContext, item: tuple[int, AmbienceRegion]) -> RegionalResult:
    index, region = item
    _check_cancel(context.cancel)
    if region.ratio <= region.existing_ratio * (1 + 1e-6):
        report = {
            **region.payload(),
            "midSendGain": 0.0,
            "sideSendGain": 0.0,
            "decision": "already-present",
        }
        return None, report, None
    path = context.work / f"ambience-{index}.wav"
    render = convolve_compact_return if context.compact else convolve_return
    span = render(context.voice, path, region, _impulse(region, context.rate), context.cancel)
    mid, side = _calibrate_region(
        context.voice_energy,
        path,
        region,
        context.existing_wet,
        context.added_energy,
        context.cancel,
        span=span,
    )
    report = {
        **region.payload(),
        "midSendGain": mid,
        "sideSendGain": side,
        "existingAndAddedMonoWetRatioBound": context.existing_wet,
        "legacySideEnergyAccounted": context.legacy_present,
        "decision": "estimated-addition",
    }
    return ("regional-ambience", path, mid, side), report, span


def _collect_regions(
    results: Iterable[RegionalResult], compact: dict[Path, ReturnSpan] | None
) -> tuple[list[RegionalBus], list[dict[str, object]]]:
    buses, reports = [], []
    for bus, report, span in results:
        if bus is not None:
            buses.append(bus)
            if compact is not None and span is not None:
                compact[bus[1]] = span
        reports.append(report)
    return buses, reports


def _regional_buses(
    voice: Path,
    work: Path,
    regions: list[AmbienceRegion],
    existing_wet: float,
    legacy: list[tuple[str, Path, float]],
    cancel: threading.Event,
    *,
    compact: dict[Path, ReturnSpan] | None = None,
    voice_energy: np.ndarray | None = None,
) -> tuple[list[RegionalBus], list[dict[str, object]]]:
    _check_cancel(cancel)
    if not regions:
        return [], []
    active = any(region.ratio > region.existing_ratio * (1 + 1e-6) for region in regions)
    if voice_energy is None:
        voice_energy = _field_envelopes(voice, cancel) if active else np.empty((0, 2, 2))
    added_energy = _added_field_energy(legacy, voice_energy, cancel) if active else voice_energy
    context = _RegionalContext(
        voice,
        work,
        voice_energy,
        added_energy,
        existing_wet,
        bool(legacy),
        sf.info(voice).samplerate if active else 0,
        cancel,
        compact is not None,
    )
    return _collect_regions(
        ordered_map(partial(_regional_bus, context), enumerate(regions)), compact
    )


def _wet_block(
    rooms: list[RegionalReader],
    legacy: list[tuple[str, sf.SoundFile, float]],
    block: np.ndarray,
    energies: dict[str, float],
    mono_energies: dict[str, float],
    channels: int,
    offset: int,
    legacy_duck: Callable[[np.ndarray], np.ndarray] | None,
) -> np.ndarray:
    ducking = legacy_duck(block) if legacy and legacy_duck is not None else None
    returns = _read_regional(rooms, len(block), offset)
    for name, reader, gain in legacy:
        assert ducking is not None
        added = reader.read(len(block), always_2d=True) * gain * ducking
        returns[name] = returns.get(name, np.zeros_like(added)) + added
    wet = np.zeros((len(block), channels))
    for name, added in returns.items():
        wet += added
        energies[name] = energies.get(name, 0.0) + float(np.sum(added**2))
        mono_energies[name] = mono_energies.get(name, 0.0) + float(np.sum(added.mean(axis=1) ** 2))
    return wet


def _mix_buses(
    voice: Path,
    target: Path,
    regional: list[RegionalBus],
    legacy: list[tuple[str, Path, float]],
    cancel: threading.Event,
    legacy_duck: Callable[[np.ndarray], np.ndarray] | None,
    *,
    compact: dict[Path, ReturnSpan] | None = None,
) -> tuple[dict[str, float], float, float, dict[str, float]]:
    info = sf.info(voice)
    energies: dict[str, float] = {}
    mono_energies: dict[str, float] = {}
    dry_energy = dry_mono_energy = 0.0
    with ExitStack() as stack:
        source = stack.enter_context(sf.SoundFile(voice))
        rooms = [
            (name, stack.enter_context(sf.SoundFile(path)), mid, side, (compact or {}).get(path))
            for name, path, mid, side in regional
        ]
        old = [(name, stack.enter_context(sf.SoundFile(path)), gain) for name, path, gain in legacy]
        output = stack.enter_context(
            _temporary_wave(target, samplerate=info.samplerate, channels=info.channels)
        )
        offset = 0
        for block in source.blocks(blocksize=32768, always_2d=True):
            _check_cancel(cancel)
            wet = _wet_block(
                rooms, old, block, energies, mono_energies, info.channels, offset, legacy_duck
            )
            dry_energy += float(np.sum(block**2))
            dry_mono_energy += float(np.sum(block.mean(axis=1) ** 2))
            output.write(block + wet)
            offset += len(block)
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
    legacy_duck: Callable[[np.ndarray], np.ndarray] | None,
    ambience: ReferenceAmbience | None = None,
) -> dict[str, object]:
    fields = RegionalFields()
    echoes = (
        []
        if any(name == "delay" for name, _, _ in legacy)
        else plan_coherent_echoes(voice, reference, arrangement, cancel)
    )
    regions = plan_regional_ambience(
        voice, reference, arrangement, cancel, fields=fields, ambience=ambience
    )
    regions = without_echo_regions(regions, echoes)
    base_report = {
        **base_report,
        "ambienceEvidenceCoverage": _coverage(regions, echoes, arrangement.duration_seconds),
    }
    return _render_planned_returns(
        voice,
        target,
        cancel,
        regions,
        echoes,
        base_report,
        legacy,
        existing_wet,
        legacy_duck,
        fields,
    )


def _render_planned_returns(
    voice: Path,
    target: Path,
    cancel: threading.Event,
    regions: list[AmbienceRegion],
    echoes: list[EchoRegion],
    base_report: dict[str, object],
    legacy: list[tuple[str, Path, float]],
    existing_wet: float,
    legacy_duck: Callable[[np.ndarray], np.ndarray] | None,
    fields: RegionalFields,
) -> dict[str, object]:
    with TemporaryDirectory(prefix=".regional-sends-", dir=target.parent) as directory:
        work = Path(directory)
        compact: dict[Path, ReturnSpan] = {}
        rooms, reports = _regional_buses(
            voice,
            work,
            regions,
            existing_wet,
            legacy,
            cancel,
            compact=compact,
            voice_energy=fields.voice,
        )
        copies, copy_reports = echo_buses(voice, work, echoes, cancel)
        base_report["coherentEchoRegions"] = copy_reports
        rooms.extend(copies)
        if not rooms and not legacy:
            shutil.copyfile(voice, target)
            return _report(base_report, reports, {}, 0, 0, {})
        energy, dry, dry_mono, wet_mono = _mix_buses(
            voice, target, rooms, legacy, cancel, legacy_duck, compact=compact
        )
    return _report(base_report, reports, energy, dry, dry_mono, wet_mono)
