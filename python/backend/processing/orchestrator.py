from __future__ import annotations

from backend.processing.audio_pipeline import PrepareProcessingAudio, PreparedAudio
from backend.processing.document_pipeline import BuildProcessingDocument, BuiltDocument
from backend.processing.domain import (
    CancellationPolicy,
    ProcessingOptions,
    ProcessingReport,
    StageReport,
)
from backend.processing.job_manager import JobContext
from backend.processing.preflight import ProcessingProviders
from backend.processing.stage_runner import StageRunner
from backend.projects.publisher import ProjectPublisher
from backend.runtime import IdGenerator
from backend.songs.domain import Song
from backend.storage.ports import WorkStorage

_ALGORITHM_VERSION = "pipeline-1"


class PipelineOrchestrator:
    """Coordinates cohesive processing collaborators and atomic publication."""

    def __init__(
        self,
        audio: PrepareProcessingAudio,
        document: BuildProcessingDocument,
        publisher: ProjectPublisher,
        workspaces: WorkStorage,
        stages: StageRunner,
        ids: IdGenerator,
    ) -> None:
        self._audio = audio
        self._document = document
        self._publisher = publisher
        self._workspaces = workspaces
        self._stages = stages
        self._ids = ids

    def run(
        self,
        song: Song,
        options: ProcessingOptions,
        providers: ProcessingProviders,
        context: JobContext,
    ) -> ProcessingReport:
        workspace = self._workspaces.allocate(f"process-{song.song_id}")
        reports: list[StageReport] = []
        try:
            prepared = self._audio.run(
                song,
                providers,
                workspace,
                context,
                reports,
            )
            built = self._document.run(
                song,
                prepared,
                providers,
                options,
                context,
                reports,
            )
            revision = self._publish(
                song,
                prepared,
                built,
                providers,
                context,
                reports,
            )
            return self._report(song, revision, prepared, built, providers, reports)
        finally:
            self._workspaces.cleanup(workspace)

    def _publish(
        self,
        song: Song,
        prepared: PreparedAudio,
        built: BuiltDocument,
        providers: ProcessingProviders,
        context: JobContext,
        reports: list[StageReport],
    ) -> int:
        provenance = {
            "algorithmVersion": _ALGORITHM_VERSION,
            "providers": _provider_provenance(providers),
        }
        return self._stages.run(
            "ProjectValidationPublication",
            CancellationPolicy.FINISH_BEFORE_CANCEL,
            reports,
            context,
            lambda: self._publisher.publish_generated(
                song.song_id,
                song.active_revision,
                prepared.instrumental,
                prepared.reference_vocal,
                built.document,
                provenance,
                self._ids.new(),
            ),
            progress=1.0,
        )

    @staticmethod
    def _report(
        song: Song,
        revision: int,
        prepared: PreparedAudio,
        built: BuiltDocument,
        providers: ProcessingProviders,
        reports: list[StageReport],
    ) -> ProcessingReport:
        return ProcessingReport(
            song_id=song.song_id,
            revision=revision,
            stages=tuple(reports),
            providers={
                name: str(details["providerId"])
                for name, details in _provider_provenance(providers).items()
            },
            cache_used=prepared.normalized_cache_hit,
            warnings=built.discovery.warnings,
            algorithm_version=_ALGORITHM_VERSION,
        )


def _provider_provenance(
    providers: ProcessingProviders,
) -> dict[str, dict[str, object]]:
    return {
        name: {
            "providerId": provider.descriptor.provider_id,
            "providerVersion": provider.descriptor.version,
            "models": [
                {
                    "modelId": model.model_id,
                    "modelVersion": model.version,
                    "modelChecksum": model.checksum,
                }
                for model in provider.descriptor.required_models
            ],
        }
        for name, provider in (
            ("separation", providers.separation),
            ("asr", providers.asr),
            ("alignment", providers.alignment),
            ("pitch", providers.pitch),
        )
    }
