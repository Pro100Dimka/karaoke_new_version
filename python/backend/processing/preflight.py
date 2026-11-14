from __future__ import annotations

from dataclasses import dataclass

from backend.ai.domain import AiCapability
from backend.ai.ports import AiProvider
from backend.ai.provider_resolver import ResolveAiProvider
from backend.settings.domain import BackendSettings
from backend.settings.domain import ProcessingBackend


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
        capabilities = {
            "separation": AiCapability.SEPARATION,
            "asr": AiCapability.ASR,
            "alignment": AiCapability.ALIGNMENT,
            "pitch": AiCapability.PITCH,
        }
        return ProcessingProviders(
            **{
                name: self.resolve(settings, capability)
                for name, capability in capabilities.items()
            }
        )

    def resolve(self, settings: BackendSettings, capability: AiCapability) -> AiProvider:
        preferred = {
            AiCapability.SEPARATION: settings.selected_separation_provider,
            AiCapability.ASR: settings.selected_asr_provider,
            AiCapability.ALIGNMENT: settings.selected_alignment_provider,
            AiCapability.PITCH: settings.selected_pitch_provider,
        }
        provider_id = (
            "oracle-pc"
            if settings.processing_backend is not ProcessingBackend.LOCAL
            else preferred[capability]
        )
        return self._resolver.execute(capability, provider_id)


def provider_backend(provider: AiProvider) -> ProcessingBackend:
    return (
        ProcessingBackend.ORACLE
        if provider.descriptor.required_resources.get("remote")
        else ProcessingBackend.LOCAL
    )
