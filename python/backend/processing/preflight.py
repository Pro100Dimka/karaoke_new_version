from __future__ import annotations

from dataclasses import dataclass

from backend.ai.domain import AiCapability
from backend.ai.ports import AiProvider
from backend.ai.provider_resolver import ResolveAiProvider
from backend.settings.domain import BackendSettings


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
        return ProcessingProviders(
            separation=self._resolver.execute(
                AiCapability.SEPARATION,
                settings.selected_separation_provider,
            ),
            asr=self._resolver.execute(AiCapability.ASR, settings.selected_asr_provider),
            alignment=self._resolver.execute(
                AiCapability.ALIGNMENT,
                settings.selected_alignment_provider,
            ),
            pitch=self._resolver.execute(AiCapability.PITCH, settings.selected_pitch_provider),
        )
