"""Independent vocal returns, measured from the song and made only from the singer."""

from dataclasses import asdict
from collections.abc import Mapping, Sequence
from pathlib import Path
import threading
from typing import Protocol

import soundfile as sf

from backend.recordings.studio_layer_types import VocalLayerRegion
from backend.recordings.studio_layer_render import render_vocal_layers
from backend.recordings.studio_layer_timing import map_layer_regions, source_pitch_points
from backend.recordings.studio_audio import MasterRenderer
from backend.recordings.studio_pitch import PitchAnalyzer
from backend.ai.domain import PitchPoint
from backend.recordings.studio_double_analysis import analyze_doubling


class LayerRender(Protocol):
    renderer: MasterRenderer
    balanced: Path
    space_reference: Path
    info: sf._SoundFileInfo
    work: Path
    cancel: threading.Event
    pitch: PitchAnalyzer | None
    reference_pitch: Sequence[PitchPoint]
    reference_origin: float
    process_voice: bool
    timing_known: bool
    pitch_adjustments: Sequence[Mapping[str, object]]
    offset_result: tuple[float, float] | None
    processing: dict[str, object]


def analyze_reference_layers(
    reference: Path,
    cancel: threading.Event,
    reference_pitch: Sequence[PitchPoint] = (),
) -> tuple[list[VocalLayerRegion], dict[str, object]]:
    doubles, double_report = analyze_doubling(reference, cancel)
    return doubles, {"doubling": double_report}


def _unavailable_reason(render: LayerRender) -> str | None:
    if not render.process_voice:
        return "existing-effects-preserved"
    if render.pitch is None:
        return "single-performer-analysis-unavailable"
    if not render.timing_known:
        return "unconfirmed-reference-timeline"
    return None


def _reference_layers(render: LayerRender) -> tuple[list[VocalLayerRegion], dict[str, object]]:
    guide = source_pitch_points(
        render.reference_pitch,
        render.pitch_adjustments,
        render.reference_origin,
        rebuilt=render.processing.get("referenceTimelineRebuilt") is True,
    )
    return analyze_reference_layers(render.space_reference, render.cancel, guide)


def apply_reference_layers(render: LayerRender, direct: Path) -> None:
    reason = _unavailable_reason(render)
    report: dict[str, object] = {"applied": False, "method": "regional-own-voice-returns"}
    render.processing["vocalLayers"] = report
    if reason:
        report["reason"] = reason
        return
    regions, analysis = _reference_layers(render)
    mapped = map_layer_regions(
        regions,
        render.pitch_adjustments,
        render.info.duration,
        sf.info(render.space_reference).duration,
        offset_result=render.offset_result,
    )
    report.update(
        analysis=analysis,
        referenceCoordinates="full-song-seconds",
        referenceRegions=[asdict(region) for region in regions],
        performedRegions=[asdict(region) for region in mapped],
    )
    if not mapped:
        report["reason"] = "no-confident-layers-in-performed-sections"
        return
    render.balanced, synthesis = render_vocal_layers(
        render.renderer,
        direct,
        render.balanced,
        render.work / "layered-voice.wav",
        mapped,
        render.cancel,
    )
    report.update(synthesis)
    render.processing["effectsApplied"] = bool(
        render.processing.get("effectsApplied") or synthesis.get("applied")
    )
