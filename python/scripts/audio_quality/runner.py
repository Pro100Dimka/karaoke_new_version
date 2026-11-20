"""Score frozen windows once; no condition labels reach the predictor."""

from __future__ import annotations

import math
import time
from typing import Protocol

from scripts.audio_quality.contracts import (
    AudioArray,
    AuditPlan,
    AuditWindow,
    read_window,
    verify_plan_unchanged,
)
from scripts.audio_quality.model import AXES

LIMITATIONS = [
    "Audiobox resamples to 16 kHz and averages channels to mono; it cannot validate stereo sound.",
    "Its learned axes cannot establish missing-vocal, word-timing or pitch correctness.",
    "Scores do not certify studio perfection or replace controlled human listening.",
    "Frozen LUFS/true-peak calibration is not recomputed here; exact gain and sample headroom are checked.",
    "No scores are used to optimize audio, change windows or choose rendering parameters.",
]


class Predictor(Protocol):
    def score(self, samples: AudioArray, rate: int) -> dict[str, float]: ...


def _scores(value: dict[str, float]) -> dict[str, float]:
    if set(value) != set(AXES):
        raise ValueError("Predictor must return exactly the four CE/CU/PC/PQ axes")
    if not all(math.isfinite(score) for score in value.values()):
        raise ValueError("Predictor axes must all be finite")
    return {axis: float(value[axis]) for axis in AXES}


def _score_window(plan: AuditPlan, window: AuditWindow, predictor: Predictor) -> dict[str, object]:
    samples = read_window(plan, window)
    started = time.perf_counter()
    scores = _scores(predictor.score(samples, plan.rate))
    return {
        "id": window.id,
        "sourceId": window.source_id,
        "recordingId": window.recording_id,
        "windowId": window.window_id,
        "startFrame": window.start,
        "frameCount": window.frames,
        "linearGain": window.gain,
        "gainDb": window.gain_db,
        "scores": scores,
        "inferenceSeconds": time.perf_counter() - started,
    }


def score_plan(
    plan: AuditPlan, predictor: Predictor, model_provenance: dict[str, object]
) -> dict[str, object]:
    started = time.perf_counter()
    verify_plan_unchanged(plan)
    rows = [_score_window(plan, window, predictor) for window in plan.windows]
    verify_plan_unchanged(plan)
    return {
        "model": model_provenance,
        "manifestSha256": plan.manifest_sha256,
        "mappingSha256": plan.mapping_sha256,
        "sourceSha256": {key: source.sha256 for key, source in plan.sources.items()},
        "commonTargetLufs": plan.target_lufs,
        "sampleRate": plan.rate,
        "channels": plan.channels,
        "allSourceHashesUnchanged": True,
        "fixedSinglePass": True,
        "conditionLabelsUsedForScoring": False,
        "privateAudioUploaded": False,
        "auditionedByAssistant": False,
        "axisForTechnicalComparison": "PQ",
        "limitations": list(LIMITATIONS),
        "elapsedSeconds": time.perf_counter() - started,
        "rows": rows,
    }
