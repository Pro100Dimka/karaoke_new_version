from __future__ import annotations

from pathlib import Path

from backend.processing.audio_pipeline import (
    PrepareProcessingAudio,
    PreparedAudio,
    attenuate_playback_stems,
)
from backend.processing.document_pipeline import BuildProcessingDocument, BuiltDocument
from backend.processing.domain import (
    CancellationPolicy,
    ProcessingOptions,
    ProcessingReport,
    StageReport,
)
from backend.processing.job_manager import JobContext
from backend.processing.compute_policy import ExecutionContext
from backend.processing.melody_reference import RenderMelodyReference
from backend.processing.preflight import ProcessingProviders
from backend.processing.reporting import provider_provenance
from backend.processing.stage_runner import StageRunner
from backend.projects.publisher import ProjectPublisher
from backend.runtime import IdGenerator
from backend.songs.domain import Song
from backend.storage.ports import WorkStorage

_ALGORITHM_VERSION = "pipeline-12"


class PipelineOrchestrator:
    """Coordinates cohesive processing collaborators and atomic publication."""

    def __init__(
        self,
        audio: PrepareProcessingAudio,
        document: BuildProcessingDocument,
        melody: RenderMelodyReference,
        publisher: ProjectPublisher,
        workspaces: WorkStorage,
        stages: StageRunner,
        ids: IdGenerator,
    ) -> None:
        self._audio = audio
        self._document = document
        self._melody = melody
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
        execution: ExecutionContext,
    ) -> ProcessingReport:
        workspace = self._workspaces.allocate(f"process-{song.song_id}")
        reports: list[StageReport] = []
        try:
            prepared = self._audio.run(song, providers, workspace, context, reports, execution)
            built = self._document.run(
                song, prepared, providers, options, context, reports, execution
            )
            melody = self._render_melody(built, workspace, context, reports)
            revision = self._publish(song, prepared, melody, built, providers, context, reports)
            return self._report(song, revision, prepared, built, providers, reports)
        finally:
            self._workspaces.cleanup(workspace)

    def _render_melody(
        self,
        built: BuiltDocument,
        workspace: Path,
        context: JobContext,
        reports: list[StageReport],
    ) -> Path:
        return self._stages.run(
            "MelodyReference",
            CancellationPolicy.FINISH_BEFORE_CANCEL,
            reports,
            context,
            lambda: self._melody.run(built.document, workspace),
            progress=0.96,
        )

    def _publish(
        self,
        song: Song,
        prepared: PreparedAudio,
        melody: Path,
        built: BuiltDocument,
        providers: ProcessingProviders,
        context: JobContext,
        reports: list[StageReport],
    ) -> int:
        instrumental, reference = attenuate_playback_stems(
            (prepared.instrumental, prepared.reference_vocal),
            melody.parent / "playback",
            context.cancel,
        )
        return self._stages.run(
            "ProjectValidationPublication",
            CancellationPolicy.FINISH_BEFORE_CANCEL,
            reports,
            context,
            lambda: self._publisher.publish_generated(
                song.song_id,
                song.active_revision,
                instrumental,
                reference,
                melody,
                built.document,
                _provenance(built, providers, prepared),
                self._ids.new(),
                analysis_audio={
                    "analysisVocal": prepared.reference_vocal,
                    "analysisInstrumental": prepared.instrumental,
                    **({"rawVocal": prepared.raw_vocal} if prepared.raw_vocal else {}),
                },
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
            warnings=built.warnings,
            algorithm_version=_ALGORITHM_VERSION,
        )


def _provenance(
    built: BuiltDocument, providers: ProcessingProviders, prepared: PreparedAudio
) -> dict[str, object]:
    return {
        "algorithmVersion": _ALGORITHM_VERSION,
        "playbackPeakDbfs": -18,
        "analysisPreparation": prepared.preparation.get("algorithmVersion", "raw-stems-1"),
        "vocalPreparation": dict(prepared.preparation),
        "modelAudioPreparation": "phase-safe-mono-2",
        "providers": _provider_provenance(providers),
        "lyricsSource": built.discovery.source,
        "lyricsSourceText": built.discovery.lyrics,
        "unverifiedRepeatLyrics": built.discovery.unverified_repeat_lyrics,
        "lyricsTimingHints": [
            {"start": hint.start, "text": hint.text} for hint in built.discovery.timing_hints
        ],
        "warnings": list(built.warnings),
    }


def _provider_provenance(
    providers: ProcessingProviders,
) -> dict[str, dict[str, object]]:
    return {
        name: provider_provenance(provider.descriptor)
        for name, provider in (
            ("separation", providers.separation),
            ("asr", providers.asr),
            ("alignment", providers.alignment),
            ("pitch", providers.pitch),
        )
    }
