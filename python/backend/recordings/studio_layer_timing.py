"""Translate measured song layers to the actual performance, without moving dry audio."""

from collections.abc import Mapping, Sequence
from dataclasses import replace
import math

from backend.analysis.scoring import parse_playback_adjustments
from backend.analysis.domain import PlaybackAdjustment
from backend.ai.domain import PitchPoint
from backend.recordings.studio_layer_types import VocalLayerRegion


def _map_region(
    region: VocalLayerRegion,
    point: PlaybackAdjustment,
    end: float,
    reference_duration: float,
    correction: float,
) -> VocalLayerRegion | None:
    if not all(math.isfinite(x) for x in (region.start, region.end)):
        return None
    source_start, source_end = max(0.0, region.start), min(reference_duration, region.end)
    start = (
        point.elapsed_seconds
        + (source_start - point.source_seconds - correction) / point.playback_rate
    )
    stop = (
        point.elapsed_seconds
        + (source_end - point.source_seconds - correction) / point.playback_rate
    )
    start, stop = max(point.elapsed_seconds, start), min(end, stop)
    if stop <= start:
        return None
    return replace(
        region,
        start=start,
        end=stop,
        delay_ms=region.delay_ms / point.playback_rate,
        modulation_ms=region.modulation_ms / point.playback_rate,
    )


def map_layer_regions(
    regions: Sequence[VocalLayerRegion],
    adjustments: Sequence[Mapping[str, object]],
    duration: float,
    reference_duration: float,
    *,
    offset_result: tuple[float, float] | None = None,
) -> list[VocalLayerRegion]:
    """Input regions use the full song timeline, never the scoped reference PCM."""
    if not all(math.isfinite(x) and x > 0 for x in (duration, reference_duration)):
        return []
    correction = 0.0
    if offset_result and all(math.isfinite(x) for x in offset_result) and offset_result[1] >= 0.9:
        correction = offset_result[0]
        if not adjustments:
            adjustments = [dict(elapsedSeconds=0, sourceSeconds=0, playbackRate=1, keyShift=0)]
    points = parse_playback_adjustments(adjustments)
    if not points or len(points) != len(adjustments) or points[0].elapsed_seconds != 0:
        return []
    ends = [point.elapsed_seconds for point in points[1:]] + [duration]
    if any(end <= point.elapsed_seconds for point, end in zip(points, ends)):
        return []
    mapped = []
    for point, end in zip(points, ends):
        for region in regions:
            result = _map_region(region, point, min(end, duration), reference_duration, correction)
            if result is not None:
                mapped.append(result)
    return sorted(mapped, key=lambda region: (region.start, region.end, region.kind))


def source_pitch_points(
    points: Sequence[PitchPoint],
    adjustments: Sequence[Mapping[str, object]],
    origin: float,
    *,
    rebuilt: bool,
) -> tuple[PitchPoint, ...]:
    """Reuse measured reference notes in full-song PCM coordinates, without inferring notes."""
    segments = parse_playback_adjustments(adjustments) if rebuilt else ()
    if rebuilt and (not segments or len(segments) != len(adjustments)):
        return ()
    chosen: dict[float, PitchPoint] = {}
    for point in points:
        if not math.isfinite(point.time):
            continue
        time = point.time + origin
        for segment in segments:
            if segment.elapsed_seconds > point.time:
                break
            time = (
                segment.source_seconds
                + (point.time - segment.elapsed_seconds) * segment.playback_rate
            )
        key = round(time, 9)
        if key < 0 or not math.isfinite(key):
            continue
        previous = chosen.get(key)
        if previous is None or point.confidence > previous.confidence:
            chosen[key] = PitchPoint(time, point.frequency, point.confidence, point.audio_active)
    return tuple(chosen[time] for time in sorted(chosen))
