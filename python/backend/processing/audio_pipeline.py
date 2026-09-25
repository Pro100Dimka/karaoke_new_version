from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from backend.processing.ai_stages import SeparationStage
from backend.processing.algorithms import MusicMetadata
from backend.processing.domain import CancellationPolicy, StageReport
from backend.processing.job_manager import JobContext
from backend.processing.compute_policy import ExecutionContext
from backend.processing.normalize_stage import NormalizeStage
from backend.processing.ports import MusicAnalyzer
from backend.processing.preflight import ProcessingProviders
from backend.processing.reference_stage import PrepareReferenceVocal
from backend.processing.stage_runner import StageRunner
from backend.songs.domain import Song


@dataclass(frozen=True, slots=True)
class PreparedAudio:
    normalized_cache_hit: bool
    music: MusicMetadata
    instrumental: Path
    reference_vocal: Path


class PrepareProcessingAudio:
    """Runs the audio-only preparation stages for an offline processing job."""

    def __init__(
        self,
        normalize: NormalizeStage,
        music: MusicAnalyzer,
        separation: SeparationStage,
        reference: PrepareReferenceVocal,
        stages: StageRunner,
    ) -> None:
        self._normalize = normalize
        self._music = music
        self._separation = separation
        self._reference = reference
        self._stages = stages

    def run(
        self,
        song: Song,
        providers: ProcessingProviders,
        workspace: Path,
        context: JobContext,
        reports: list[StageReport],
        execution: ExecutionContext,
    ) -> PreparedAudio:
        normalized, cache_hit = self._normalize_audio(song, workspace, context, reports)
        music = self._analyze_music(normalized, context, reports)
        instrumental, reference = self._separate(
            normalized,
            workspace,
            providers,
            context,
            reports,
            execution,
        )
        return PreparedAudio(cache_hit, music, instrumental, reference)

    def _normalize_audio(
        self,
        song: Song,
        workspace: Path,
        context: JobContext,
        reports: list[StageReport],
    ) -> tuple[Path, bool]:
        return self._stages.run(
            "DecodeNormalize",
            CancellationPolicy.INTERRUPTIBLE,
            reports,
            context,
            lambda: self._normalize.run(song, workspace, context.cancel),
            progress=0.10,
        )

    def _analyze_music(
        self,
        normalized: Path,
        context: JobContext,
        reports: list[StageReport],
    ) -> MusicMetadata:
        return self._stages.run(
            "MusicAnalysis",
            CancellationPolicy.FINISH_BEFORE_CANCEL,
            reports,
            context,
            lambda: self._music.analyze(normalized),
            progress=0.22,
        )

    def _separate(
        self,
        normalized: Path,
        workspace: Path,
        providers: ProcessingProviders,
        context: JobContext,
        reports: list[StageReport],
        execution: ExecutionContext,
    ) -> tuple[Path, Path]:
        separated = self._stages.run(
            "StemSeparation",
            CancellationPolicy.INTERRUPTIBLE,
            reports,
            context,
            lambda: self._separation.run(
                normalized,
                workspace,
                providers.separation,
                context.cancel,
                execution=execution,
            ),
            progress=0.42,
        )
        reference = self._stages.run(
            "ReferenceVocalPreparation",
            CancellationPolicy.FINISH_BEFORE_CANCEL,
            reports,
            context,
            lambda: self._reference.run(separated.reference_vocal),
            progress=0.48,
        )
        return separated.instrumental, reference
