from __future__ import annotations

from dataclasses import dataclass, replace
from collections.abc import Callable

from backend.ai.domain import PitchPoint, WordTiming
from backend.lyrics.discovery import LyricsDiscovery, LyricsDiscoveryResult, lyrics_language
from backend.lyrics.domain import LyricsDocument
from backend.processing.algorithms import construct_document, stabilize_pitch
from backend.processing.audio_pipeline import PreparedAudio
from backend.processing.domain import CancellationPolicy, ProcessingOptions, StageReport
from backend.processing.job_manager import JobContext
from backend.processing.compute_policy import ComputeDevice, ExecutionContext
from backend.processing.policies import concurrent_stage_thread_split
from backend.processing.ports import ConcurrentRunner
from backend.processing.reporting import alignment_warnings, pitch_warnings
from backend.processing.preflight import ProcessingProviders
from backend.processing.stage_runner import StageRunner
from backend.songs.domain import Song


@dataclass(frozen=True, slots=True)
class BuiltDocument:
    document: LyricsDocument
    discovery: LyricsDiscoveryResult
    warnings: tuple[str, ...]


class BuildProcessingDocument:
    """Build lyrics and pitch in parallel within the admitted CPU thread budget."""

    def __init__(
        self,
        discovery: LyricsDiscovery,
        stages: StageRunner,
        concurrency: ConcurrentRunner,
    ) -> None:
        self._discovery = discovery
        self._stages = stages
        self._concurrency = concurrency

    def run(
        self,
        song: Song,
        prepared: PreparedAudio,
        providers: ProcessingProviders,
        options: ProcessingOptions,
        context: JobContext,
        reports: list[StageReport],
        execution: ExecutionContext,
    ) -> BuiltDocument:
        align_threads, pitch_threads = concurrent_stage_thread_split(execution.cpu_threads)
        align_execution = replace(execution, cpu_threads=align_threads)
        pitch_execution = replace(execution, cpu_threads=pitch_threads)
        discovery = self._discover(
            song, prepared, providers, options, context, reports, execution
        )
        parallel = not discovery.timing_hints or execution.device is ComputeDevice.CUDA
        if not parallel:
            align_execution = pitch_execution = execution
        pitch_reports: list[StageReport] = []
        stable: tuple[PitchPoint, ...] = ()
        words: tuple[WordTiming, ...] = ()

        def run_pitch() -> None:
            nonlocal stable
            stable = self._stable_pitch(
                prepared, providers, context, pitch_reports, pitch_execution
            )

        def run_align() -> None:
            nonlocal words
            words = self._align(
                song, prepared, discovery, providers, context, reports, align_execution
            )

        self._run_stages(execution, run_align, run_pitch, parallel=parallel)
        reports.extend(pitch_reports)
        document = self._construct(song, prepared, discovery, words, stable, context, reports)
        warnings = discovery.warnings + alignment_warnings(words) + pitch_warnings(stable)
        return BuiltDocument(replace(document, rhythm=prepared.rhythm), discovery, warnings)

    def _run_stages(
        self, execution: ExecutionContext, *stages: Callable[[], None], parallel: bool
    ) -> None:
        if parallel and execution.cpu_threads > 1:
            self._concurrency.run_concurrently(*stages)
        else:
            for stage in stages:
                stage()

    def _discover(
        self,
        song: Song,
        prepared: PreparedAudio,
        providers: ProcessingProviders,
        options: ProcessingOptions,
        context: JobContext,
        reports: list[StageReport],
        execution: ExecutionContext,
    ) -> LyricsDiscoveryResult:
        return self._stages.run(
            "LyricsDiscovery",
            CancellationPolicy.INTERRUPTIBLE,
            reports,
            context,
            lambda: self._discovery.discover(
                song,
                prepared.reference_vocal,
                providers.asr,
                context.cancel,
                online_enabled=options.online_lyrics,
                execution=execution,
            ),
            progress=0.60,
        )

    def _align(
        self,
        song: Song,
        prepared: PreparedAudio,
        discovery: LyricsDiscoveryResult,
        providers: ProcessingProviders,
        context: JobContext,
        reports: list[StageReport],
        execution: ExecutionContext,
    ) -> tuple[WordTiming, ...]:
        words = self._stages.run(
            "ForcedAlignment",
            CancellationPolicy.INTERRUPTIBLE,
            reports,
            context,
            lambda: providers.alignment.align(
                prepared.reference_vocal,
                discovery.lyrics,
                lyrics_language(song, discovery.lyrics),
                context.cancel,
                timing_hints=discovery.timing_hints,
                execution=execution,
                instrumental=prepared.instrumental,
            ),
            progress=0.72,
        )
        return tuple(words)

    def _stable_pitch(
        self,
        prepared: PreparedAudio,
        providers: ProcessingProviders,
        context: JobContext,
        reports: list[StageReport],
        execution: ExecutionContext,
    ) -> tuple[PitchPoint, ...]:
        pitch = self._stages.run(
            "PitchAnalysis",
            CancellationPolicy.INTERRUPTIBLE,
            reports,
            context,
            lambda: providers.pitch.pitch(
                prepared.reference_vocal, context.cancel, execution=execution
            ),
            progress=0.82,
        )
        return self._stages.run(
            "PitchStabilization",
            CancellationPolicy.FINISH_BEFORE_CANCEL,
            reports,
            context,
            lambda: stabilize_pitch(pitch),
            progress=0.87,
        )

    def _construct(
        self,
        song: Song,
        prepared: PreparedAudio,
        discovery: LyricsDiscoveryResult,
        words: tuple[WordTiming, ...],
        pitch: tuple[PitchPoint, ...],
        context: JobContext,
        reports: list[StageReport],
    ) -> LyricsDocument:
        return self._stages.run(
            "NoteConstruction",
            CancellationPolicy.FINISH_BEFORE_CANCEL,
            reports,
            context,
            lambda: construct_document(
                song.title,
                song.artist,
                song.duration or 0.0,
                discovery.lyrics,
                words,
                pitch,
                prepared.music,
            ),
            progress=0.93,
        )
