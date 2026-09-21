from __future__ import annotations

from backend.ai.domain import AiCapability
from backend.ai.ports import AiProvider
from backend.ai.registry import AiProviderRegistry
from backend.models.commands import EnsureRequiredModels


class ResolveAiProvider:
    def __init__(self, registry: AiProviderRegistry, models: EnsureRequiredModels) -> None:
        self._registry = registry
        self._models = models

    def execute(self, capability: AiCapability, preferred_id: str | None) -> AiProvider:
        provider = self._registry.resolve(capability, preferred_id)
        self._models.execute(list(provider.descriptor.required_models))
        return provider
