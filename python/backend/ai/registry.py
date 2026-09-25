from __future__ import annotations

from collections.abc import Sequence

from backend.ai.domain import AiCapability, AiProviderDescriptor
from backend.ai.ports import AiProvider
from backend.domain_errors import ConflictError, DependencyError


class AiProviderRegistry:
    def __init__(self, providers: Sequence[AiProvider]) -> None:
        self._providers = {provider.descriptor.provider_id: provider for provider in providers}

    def descriptors(self) -> tuple[AiProviderDescriptor, ...]:
        return tuple(provider.descriptor for provider in self._providers.values())

    def resolve(self, capability: AiCapability, preferred_id: str | None = None) -> AiProvider:
        if preferred_id:
            provider = self._providers.get(preferred_id)
            if provider is None or capability not in provider.descriptor.capabilities:
                raise DependencyError(
                    "AiProviderUnavailable",
                    "Selected AI provider cannot provide the required capability",
                    providerId=preferred_id,
                    capability=capability.value,
                )
            return provider
        matches = [
            provider
            for provider in self._providers.values()
            if capability in provider.descriptor.capabilities
            and not provider.descriptor.required_resources.get("remote")
        ]
        if not matches:
            raise DependencyError(
                "AiProviderUnavailable",
                "No AI provider supports the required capability",
                capability=capability.value,
            )
        if len(matches) > 1:
            raise ConflictError(
                "AiProviderSelectionRequired",
                "Multiple AI providers are available; select one explicitly",
                capability=capability.value,
            )
        return matches[0]
