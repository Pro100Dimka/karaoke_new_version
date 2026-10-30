from __future__ import annotations

from pathlib import Path
from dataclasses import replace
from concurrent.futures import Future

from backend.processing.audio_pipeline import (
    PrepareProcessingAudio,
    PreparedAudio,
    attenuate_playback_stems,
    SeparationOperation,
)
from backend.ai.domain import SeparatedAudio
from backend.ai.ports import StreamingTranscriber
from backend.lyrics.discovery import PreparedLyrics
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
from backend.processing.policies import concurrent_stage_thread_split
from backend.processing.ports import ConcurrentRunner
from backend.projects.publisher import ProjectPublisher
from backend.runtime import IdGenerator
from backend.songs.domain import Song
from backend.storage.ports import WorkStorage

_ALGORITHM_VERSION = "pipeline-3"


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
        concurrency: ConcurrentRunner | None = None,
    ) -> None:
        self._audio = audio
        self._document = document
        self._melody = melody
        self._publisher = publisher
        self._workspaces = workspaces
        self._stages = stages
        self._ids = ids
        self._concurrency = concurrency

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
            prepared, lyrics = self._prepare(
                song, options, providers, workspace, context, reports, execution
            )
            built = self._document.run(
                song,
                prepared,
                providers,
                options,
                context,
                reports,
                execution,
                prepared_lyrics=lyrics,
            )
            melody = self._render_melody(built, workspace, context, reports)
            instrumental, reference = attenuate_playback_stems(
                (prepared.instrumental, prepared.reference_vocal),
                workspace / "playback",
                context.cancel,
            )
            prepared = replace(prepared, instrumental=instrumental, reference_vocal=reference)
            revision = self._publish(song, prepared, melody, built, providers, context, reports)
            return self._report(song, revision, prepared, built, providers, reports)
        finally:
            self._workspaces.cleanup(workspace)

    def _prepare(
        self,
        song: Song,
        options: ProcessingOptions,
        providers: ProcessingProviders,
        workspace: Path,
        context: JobContext,
        reports: list[StageReport],
        execution: ExecutionContext,
    ) -> tuple[PreparedAudio, PreparedLyrics | None]:
        asr, concurrency = providers.asr, self._concurrency
        fraction = execution.parallel_cpu_fraction
        if fraction is None or concurrency is None or not isinstance(asr, StreamingTranscriber):
            return self._audio.run(song, providers, workspace, context, reports, execution), None
        source = self._document.find_lyrics(song, options, context, reports)
        original = song.source_path
        if source.found is None or original is None:
            return self._audio.run(song, providers, workspace, context, reports, execution), source
        lyrics = source

        def overlap(separate: SeparationOperation) -> SeparatedAudio:
            nonlocal lyrics
            separated, lyrics = self._overlap(
                song, source, original, asr, separate, context, reports, execution, concurrency
            )
            return separated

        prepared = self._audio.run(
            song, providers, workspace, context, reports, execution, during_separation=overlap
        )
        return prepared, lyrics

    def _overlap(
        self,
        song: Song,
        source: PreparedLyrics,
        original: Path,
        asr: StreamingTranscriber,
        separate: SeparationOperation,
        context: JobContext,
        reports: list[StageReport],
        execution: ExecutionContext,
        concurrency: ConcurrentRunner,
    ) -> tuple[SeparatedAudio, PreparedLyrics]:
        asr_plan, separation_plan = (
            _limited_execution(execution, threads)
            for threads in concurrent_stage_thread_split(execution.cpu_threads)
        )
        separated: Future[SeparatedAudio] = Future()
        lyric_reports: list[StageReport] = []
        lyrics = source

        def split() -> None:
            try:
                separated.set_result(separate(separation_plan))
            finally:
                # Release the dependent reader if separation exits without providing audio.
                separated.cancel()

        def recognize() -> None:
            nonlocal lyrics
            lyrics = self._document.recognize_lyrics(
                song, source, original, separated, asr, context, lyric_reports, asr_plan
            )

        concurrency.run_concurrently(split, recognize)
        reports.extend(lyric_reports)
        return separated.result(), lyrics

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
        provenance = {
            "algorithmVersion": _ALGORITHM_VERSION,
            "playbackPeakDbfs": -18,
            "providers": _provider_provenance(providers),
            "lyricsSource": built.discovery.source,
            "lyricsSourceText": built.discovery.lyrics,
            "lyricsTimingHints": [
                {"start": hint.start, "text": hint.text} for hint in built.discovery.timing_hints
            ],
            "warnings": list(built.warnings),
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
                melody,
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
            warnings=built.warnings,
            algorithm_version=_ALGORITHM_VERSION,
        )


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


def _limited_execution(execution: ExecutionContext, threads: int) -> ExecutionContext:
    assert execution.parallel_cpu_fraction is not None
    return replace(
        execution,
        cpu_threads=threads,
        numeric_cpu_threads=execution.cpu_threads,
        cpu_fraction=execution.parallel_cpu_fraction * threads / execution.cpu_threads,
    )
