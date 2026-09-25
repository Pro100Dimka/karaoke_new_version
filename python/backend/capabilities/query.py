from __future__ import annotations

from backend.ai.domain import AiCapability
from backend.ai.registry import AiProviderRegistry
from backend.capabilities.domain import Capabilities
from backend.diagnostics.ports import RuntimeProbe
from backend.persistence import UnitOfWorkFactory
from backend.settings.domain import ProcessingBackend


class GetCapabilities:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        providers: AiProviderRegistry,
        runtime: RuntimeProbe,
        *,
        online_lyrics_available: bool,
    ) -> None:
        self._uow = uow
        self._providers = providers
        self._runtime = runtime
        self._online_lyrics = online_lyrics_available

    def execute(self) -> Capabilities:
        available = {capability: self._available(capability) for capability in AiCapability}
        runtime = self._runtime.inspect()
        processing = all(
            available.get(capability, False)
            for capability in (
                AiCapability.SEPARATION,
                AiCapability.ASR,
                AiCapability.ALIGNMENT,
                AiCapability.PITCH,
            )
        )
        return Capabilities(
            can_import_songs=runtime.ffmpeg_version is not None,
            can_process_songs=processing and runtime.ffmpeg_version is not None,
            can_separate=available.get(AiCapability.SEPARATION, False),
            can_run_asr=available.get(AiCapability.ASR, False),
            can_run_alignment=available.get(AiCapability.ALIGNMENT, False),
            can_analyze_pitch=available.get(AiCapability.PITCH, False),
            can_analyze_recording=True,
            can_use_cuda=runtime.cuda_available,
            online_lyrics_available=self._online_lyrics,
            package_import_available=True,
            package_export_available=True,
        )

    def _available(self, capability: AiCapability) -> bool:
        with self._uow.create() as transaction:
            settings = transaction.settings.get()
            remote = settings.processing_backend is ProcessingBackend.KAGGLE
            candidates = [
                descriptor
                for descriptor in self._providers.descriptors()
                if capability in descriptor.capabilities
                and bool(descriptor.required_resources.get("remote")) is remote
            ]
            if remote and (not settings.kaggle_url or not settings.kaggle_token):
                return False
            return any(
                not transaction.models.missing(descriptor.required_models)
                for descriptor in candidates
            )
