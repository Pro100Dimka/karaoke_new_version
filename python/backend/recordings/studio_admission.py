from __future__ import annotations

from dataclasses import dataclass
from threading import Event

from backend.ai.domain import AiCapability
from backend.ai.ports import AiProvider
from backend.ai.provider_resolver import ResolveAiProvider
from backend.domain_errors import ConflictError, DomainError
from backend.processing.resource_scheduler import ProcessingResourceScheduler, ResourceLease
from backend.recordings.domain import Recording
from backend.recordings.studio_audio import recording_stems, recoverable_recording_sources
from backend.settings.domain import BackendSettings


@dataclass(frozen=True, slots=True)
class StudioMasterResources:
    provider: AiProvider | None
    lease: ResourceLease


def separation_provider(resolver: ResolveAiProvider, settings: BackendSettings) -> AiProvider:
    # Studio Master must never activate a user-selected Kaggle session implicitly.
    selected = settings.selected_separation_provider
    return resolver.execute(
        AiCapability.SEPARATION, None if selected == "kaggle-p100" else selected
    )


def admit_studio_master(
    recording: Recording,
    cancel: Event,
    resolver: ResolveAiProvider,
    settings: BackendSettings,
    resources: ProcessingResourceScheduler,
) -> StudioMasterResources:
    if cancel.is_set():
        raise ConflictError("JobCancelled", "Studio Master was cancelled")
    # Inspect headers only: recovery itself runs on an execution worker under its CPU lease.
    sources = recording_stems(recording.file_path, prefer_dry=True)
    recoverable = (
        sources is not None or recoverable_recording_sources(recording.file_path) is not None
    )
    provider = None if recoverable else separation_provider(resolver, settings)
    source_bytes = recording.file_path.stat().st_size
    while not cancel.is_set():
        try:
            lease = (
                resources.claim_cpu(source_bytes, cpu_threads=settings.cpu_threads)
                if provider is None
                else resources.claim_provider(
                    provider, source_bytes, settings.compute_mode, cpu_threads=settings.cpu_threads
                )
            )
            return StudioMasterResources(provider, lease)
        except DomainError as error:
            if error.code != "ResourceBudgetExceeded":
                raise
            cancel.wait(0.1)
    raise ConflictError("JobCancelled", "Studio Master was cancelled")
