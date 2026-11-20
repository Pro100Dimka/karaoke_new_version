"""Reference-only ambience templates; current vocal room energy is bound at mixing."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, replace
from pathlib import Path
import threading

import numpy as np
import soundfile as sf

from backend.domain_errors import DependencyError
from backend.recordings.studio_arrangement import ArrangementMap
from backend.recordings.studio_audio import _check_cancel
from backend.recordings.studio_regional_evidence import (
    _global_priors,
    _section_evidence,
    _valid_intervals,
    coherent_pan as _coherent_pan,
    envelope_relatedness as _local_relatedness,
)
from backend.recordings.studio_regional_returns import AmbienceRegion
from backend.recordings.studio_space_analysis import _field_envelopes

FileIdentity = tuple[int, int, int, int, int]


def _identity(path: Path) -> FileIdentity:
    try:
        stat = path.stat()
    except OSError as error:
        raise DependencyError(
            "StudioMasterInvalidAudio", "Ambience reference is unavailable"
        ) from error
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns


@dataclass(frozen=True, slots=True)
class ReferenceAmbience:
    reference: Path
    identity: FileIdentity
    arrangement: ArrangementMap
    regions: tuple[AmbienceRegion, ...]

    def validate(
        self, reference: Path, arrangement: ArrangementMap, cancel: threading.Event
    ) -> None:
        _check_cancel(cancel)
        if reference != self.reference or arrangement is not self.arrangement:
            raise DependencyError("StudioMasterStemMismatch", "Ambience reference context changed")
        if _identity(reference) != self.identity:
            raise DependencyError("StudioMasterInvalidAudio", "Ambience reference changed")


def _existing_ratio(
    existing: np.ndarray | None, start: float, end: float, band_index: int
) -> float:
    if existing is None:
        return 0.0
    current = existing[slice(round(start * 50), round(end * 50)), band_index]
    return float(current[:, 1].sum() / max(current[:, 0].sum(), 1e-20))


def _candidate_region(
    start: float,
    end: float,
    reference: np.ndarray,
    existing: np.ndarray | None,
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
        present = _existing_ratio(existing, start, end, index)
        if ratio < 1e-4:
            continue
        region = AmbienceRegion(start, end, kernel, band, index, ratio, present, score, method)
        candidates.append((score * values[:, 1].sum(), region))
    return max(candidates, key=lambda item: item[0])[1] if candidates else None


def _repeat_contexts(
    arrangement: ArrangementMap,
    regions: list[AmbienceRegion],
    expected: np.ndarray,
    existing: np.ndarray | None,
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
    existing: np.ndarray | None,
    prior: tuple[np.ndarray, float],
) -> AmbienceRegion | None:
    start, end = bounds
    section = slice(round(start * 50), round(end * 50))
    values = expected[section, 1]
    if _local_relatedness(values) <= 0:
        return None
    observed = float(values[:, 1].sum() / max(values[:, 0].sum(), 1e-20))
    ratio = min(observed, float(prior[0].sum()) * 0.5, 0.35)
    if ratio < 1e-4:
        return None
    present = _existing_ratio(existing, start, end, 1)
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
    existing: np.ndarray | None,
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


def fit_reference_ambience(
    reference: Path,
    arrangement: ArrangementMap,
    expected: np.ndarray,
    cancel: threading.Event,
) -> list[AmbienceRegion]:
    if len(expected) < 300:
        return []
    priors = _global_priors(expected, arrangement)
    reference_end = sf.info(reference).duration
    duration = arrangement.frames / arrangement.rate
    regions = []
    for section in arrangement.sections:
        _check_cancel(cancel)
        end = min(section.end_seconds, reference_end, duration)
        for start, end in _valid_intervals(section.start_seconds, end, arrangement):
            region = _candidate_region(start, end, expected, None, priors)
            if region is not None:
                regions.append(region)
    regions.extend(_repeat_contexts(arrangement, regions, expected, None))
    regions.extend(
        _context_fallbacks(reference, arrangement, regions, expected, None, priors[1], cancel)
    )
    return _reference_bounds(sorted(regions, key=lambda region: region.start), arrangement)


def bind_existing_ambience(
    regions: Sequence[AmbienceRegion], existing: np.ndarray
) -> list[AmbienceRegion]:
    # Bind on the original region; echo exclusion may split it only afterwards.
    return [
        replace(
            region,
            existing_ratio=_existing_ratio(existing, region.start, region.end, region.band_index),
        )
        for region in regions
    ]


def prepare_reference_ambience(
    reference: Path | None,
    arrangement: ArrangementMap,
    cancel: threading.Event,
    *,
    channels: int,
) -> ReferenceAmbience | None:
    _check_cancel(cancel)
    if reference is None or channels != 2 or arrangement.rate <= 7000:
        return None
    identity = _identity(reference)
    expected = _field_envelopes(reference, cancel)
    regions = fit_reference_ambience(reference, arrangement, expected, cancel)
    _check_cancel(cancel)
    if _identity(reference) != identity:
        raise DependencyError(
            "StudioMasterInvalidAudio", "Ambience reference changed during analysis"
        )
    for region in regions:
        region.kernel.setflags(write=False)
    return ReferenceAmbience(reference, identity, arrangement, tuple(regions))
