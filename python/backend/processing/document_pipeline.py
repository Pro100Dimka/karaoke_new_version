from __future__ import annotations

from dataclasses import dataclass, replace
from collections.abc import Callable

from backend.ai.domain import PitchPoint, WordTiming
from backend.lyrics.discovery import LyricsDiscoveryResult
from backend.lyrics.domain import LyricsDocument
from backend.processing.ai_stages import AlignmentStage, LyricsStage, PitchStage
from backend.processing.algorithms import construct_document, refine_words, stabilize_pitch
from backend.processing.audio_pipeline import PreparedAudio
from backend.processing.domain import CancellationPolicy, ProcessingOptions, StageReport
from backend.processing.job_manager import JobContext
from backend.processing.compute_policy import ExecutionContext
from backend.processing.policies import concurrent_stage_thread_split
from backend.processing.ports import ConcurrentRunner
from backend.processing.preflight import ProcessingProviders
from backend.processing.stage_runner import StageRunner
from backend.songs.domain import Song


@dataclass(frozen=True, slots=True)
class BuiltDocument:
    document: LyricsDocument
    discovery: LyricsDiscoveryResult


class BuildProcessingDocument:
    """Build lyrics and pitch in parallel within the admitted CPU thread budget."""

    def __init__(
        self,
        lyrics: LyricsStage,
        alignment: AlignmentStage,
        pitch: PitchStage,
        stages: StageRunner,
        concurrency: ConcurrentRunner,
    ) -> None:
        self._lyrics = lyrics
        self._alignment = alignment
        self._pitch = pitch
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
        pitch_reports: list[StageReport] = []
        stable: tuple[PitchPoint, ...] = ()
        discovery: LyricsDiscoveryResult | None = None
        words: tuple[WordTiming, ...] = ()

        def run_pitch() -> None:
            nonlocal stable
            stable = self._stable_pitch(
                prepared, providers, context, pitch_reports, pitch_execution
            )

        def run_discovery_and_align() -> None:
            nonlocal discovery, words
            discovery = self._discover(
                song, prepared, providers, options, context, reports, align_execution
            )
            words = self._align(
                song, prepared, discovery, providers, context, reports, align_execution
            )

        self._run_stages(execution, run_discovery_and_align, run_pitch)
        reports.extend(pitch_reports)
        assert discovery is not None
        return BuiltDocument(
            self._notes(song, prepared, discovery, words, stable, context, reports), discovery
        )

    def _run_stages(self, execution: ExecutionContext, *stages: Callable[[], None]) -> None:
        if execution.cpu_threads > 1:
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
            lambda: self._lyrics.run(
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
            lambda: self._alignment.run(
                prepared.reference_vocal,
                discovery.lyrics,
                song,
                providers.alignment,
                context.cancel,
                execution=execution,
            ),
            progress=0.72,
        )
        return tuple(words)

    def _notes(
        self,
        song: Song,
        prepared: PreparedAudio,
        discovery: LyricsDiscoveryResult,
        words: tuple[WordTiming, ...],
        stable: tuple[PitchPoint, ...],
        context: JobContext,
        reports: list[StageReport],
    ) -> LyricsDocument:
        refined = self._refined_words(words, stable, context, reports)
        return self._construct(song, prepared, discovery, refined, stable, context, reports)

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
            lambda: self._pitch.run(
                prepared.reference_vocal, providers.pitch, context.cancel, execution=execution
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

    def _refined_words(
        self,
        words: tuple[WordTiming, ...],
        stable: tuple[PitchPoint, ...],
        context: JobContext,
        reports: list[StageReport],
    ) -> tuple[WordTiming, ...]:
        return self._stages.run(
            "VoicedIntervalMapping",
            CancellationPolicy.FINISH_BEFORE_CANCEL,
            reports,
            context,
            lambda: refine_words(words, stable),
            progress=0.90,
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
