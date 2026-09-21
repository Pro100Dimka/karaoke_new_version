from __future__ import annotations

from dataclasses import dataclass

from backend.ai.domain import PitchPoint, WordTiming
from backend.lyrics.discovery import LyricsDiscoveryResult
from backend.lyrics.domain import LyricsDocument
from backend.processing.ai_stages import AlignmentStage, LyricsStage, PitchStage
from backend.processing.algorithms import construct_document, refine_words, stabilize_pitch
from backend.processing.audio_pipeline import PreparedAudio
from backend.processing.domain import CancellationPolicy, ProcessingOptions, StageReport
from backend.processing.job_manager import JobContext
from backend.processing.preflight import ProcessingProviders
from backend.processing.stage_runner import StageRunner
from backend.songs.domain import Song


@dataclass(frozen=True, slots=True)
class BuiltDocument:
    document: LyricsDocument
    discovery: LyricsDiscoveryResult


class BuildProcessingDocument:
    """Builds lyrics, timings, pitch and notes from prepared offline audio."""

    def __init__(
        self,
        lyrics: LyricsStage,
        alignment: AlignmentStage,
        pitch: PitchStage,
        stages: StageRunner,
    ) -> None:
        self._lyrics = lyrics
        self._alignment = alignment
        self._pitch = pitch
        self._stages = stages

    def run(
        self,
        song: Song,
        prepared: PreparedAudio,
        providers: ProcessingProviders,
        options: ProcessingOptions,
        context: JobContext,
        reports: list[StageReport],
    ) -> BuiltDocument:
        discovery = self._discover(song, prepared, providers, options, context, reports)
        words = self._align(song, prepared, discovery, providers, context, reports)
        document = self._notes(song, prepared, discovery, words, providers, context, reports)
        return BuiltDocument(document, discovery)

    def _discover(
        self,
        song: Song,
        prepared: PreparedAudio,
        providers: ProcessingProviders,
        options: ProcessingOptions,
        context: JobContext,
        reports: list[StageReport],
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
        providers: ProcessingProviders,
        context: JobContext,
        reports: list[StageReport],
    ) -> LyricsDocument:
        stable = self._stable_pitch(prepared, providers, context, reports)
        refined = self._refined_words(words, stable, context, reports)
        return self._construct(song, prepared, discovery, refined, stable, context, reports)

    def _stable_pitch(
        self,
        prepared: PreparedAudio,
        providers: ProcessingProviders,
        context: JobContext,
        reports: list[StageReport],
    ) -> tuple[PitchPoint, ...]:
        pitch = self._stages.run(
            "PitchAnalysis",
            CancellationPolicy.INTERRUPTIBLE,
            reports,
            context,
            lambda: self._pitch.run(prepared.reference_vocal, providers.pitch, context.cancel),
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
