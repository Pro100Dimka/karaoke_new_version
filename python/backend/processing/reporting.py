from __future__ import annotations

from backend.ai.domain import AiProviderDescriptor
from backend.processing.domain import ProcessingReport


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
