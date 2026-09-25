from __future__ import annotations

from dataclasses import dataclass

from backend.ai.domain import AiCapability
from backend.ai.ports import AiProvider
from backend.ai.provider_resolver import ResolveAiProvider
from backend.settings.domain import BackendSettings
from backend.settings.domain import ProcessingBackend

_KAGGLE_PROVIDER = "kaggle-p100"


@dataclass(frozen=True, slots=True)
class ProcessingProviders:
    separation: AiProvider
    asr: AiProvider
    alignment: AiProvider
    pitch: AiProvider


class ProcessingPreflight:
    def __init__(self, resolver: ResolveAiProvider) -> None:
        self._resolver = resolver

    def execute(self, settings: BackendSettings) -> ProcessingProviders:
        remote = _KAGGLE_PROVIDER if settings.processing_backend is ProcessingBackend.KAGGLE else None
        return ProcessingProviders(
            separation=self._resolver.execute(
                AiCapability.SEPARATION,
                remote or settings.selected_separation_provider,
            ),
            asr=self._resolver.execute(AiCapability.ASR, remote or settings.selected_asr_provider),
            alignment=self._resolver.execute(
                AiCapability.ALIGNMENT,
                remote or settings.selected_alignment_provider,
            ),
            pitch=self._resolver.execute(AiCapability.PITCH, remote or settings.selected_pitch_provider),
        )
