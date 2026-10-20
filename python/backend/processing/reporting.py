from __future__ import annotations

from collections.abc import Sequence

from backend.ai.domain import AiProviderDescriptor, PitchPoint, WordTiming
from backend.processing.domain import ProcessingReport


def alignment_warnings(words: Sequence[WordTiming]) -> tuple[str, ...]:
    """Zero support includes proportional fallback; it is not a precise alignment."""
    approximate = [str(index) for index, word in enumerate(words) if word.confidence <= 0]
    warnings = (f"AlignmentApproximate:wordIndices={','.join(approximate)}",) if approximate else ()
    return warnings + tuple(
        f"AlignmentDiagnostic:wordIndex={index};{reason}"
        for index, word in enumerate(words) for reason in word.diagnostics
    )


def pitch_warnings(points: Sequence[PitchPoint]) -> tuple[str, ...]:
    missing = sum(point.audio_active is None for point in points)
    return (
        (f"PitchActivityUnavailable:frames={missing};unobservedGapsNotBridged",) if missing else ()
    )


def provider_provenance(descriptor: AiProviderDescriptor) -> dict[str, object]:
    return {
        "providerId": descriptor.provider_id,
        "providerVersion": descriptor.version,
        "models": [
            {
                "modelId": model.model_id,
                "modelVersion": model.version,
                "modelChecksum": model.checksum,
            }
            for model in descriptor.required_models
        ],
    }


def report_payload(report: ProcessingReport) -> dict[str, object]:
    return {
        "songId": report.song_id,
        "revision": report.revision,
        "algorithmVersion": report.algorithm_version,
        "timingOperation": report.timing_operation,
        **({"processingBackend": report.processing_backend} if report.processing_backend else {}),
        "providers": dict(report.providers),
        "cacheUsed": report.cache_used,
        "warnings": list(report.warnings),
        "stages": [
            {
                "stage": item.stage,
                "durationSeconds": item.duration_seconds,
                "cancellationPolicy": item.cancellation_policy.value,
            }
            for item in report.stages
        ],
    }
