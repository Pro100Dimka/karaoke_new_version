from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import threading

import numpy as np
import soundfile as sf

from backend.processing.algorithms import MusicMetadata
from backend.processing.domain import CancellationPolicy, StageReport
from backend.processing.job_manager import JobContext
from backend.processing.compute_policy import ExecutionContext
from backend.processing.normalize_stage import NormalizeStage
from backend.processing.ports import MusicAnalyzer
from backend.processing.preflight import ProcessingProviders
from backend.processing.stage_runner import StageRunner
from backend.projects.ports import AudioFileValidator
from backend.songs.domain import Song
from backend.domain_errors import DomainError


def attenuate_playback_stems(
    sources: tuple[Path, ...], workspace: Path, cancel: threading.Event
) -> tuple[Path, ...]:
    """Leave source/analysis audio intact; publish stems with at least 18 dB of peak headroom."""
    workspace.mkdir(parents=True, exist_ok=True)
    targets = []
    ceiling = 10 ** (-18 / 20)
    for index, source in enumerate(sources):
        peak = 0.0
        with sf.SoundFile(source) as audio:
            for block in audio.blocks(blocksize=65536, dtype="float32", always_2d=True):
                if cancel.is_set():
                    raise DomainError("JobCancelled", "Processing was cancelled", 409)
                peak = max(peak, float(np.max(np.abs(block))))
            gain = min(1.0, ceiling / peak) if peak > 0 else 1.0
            if gain == 1.0:
                targets.append(source)
                continue
            target = workspace / f"{index}-{source.name}"
            audio.seek(0)
            with sf.SoundFile(
                target, "w", samplerate=audio.samplerate, channels=audio.channels, subtype="PCM_24"
            ) as output:
                for block in audio.blocks(blocksize=65536, dtype="float32", always_2d=True):
                    if cancel.is_set():
                        raise DomainError("JobCancelled", "Processing was cancelled", 409)
                    output.write(block * gain)
            targets.append(target)
    return tuple(targets)


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
        reference: AudioFileValidator,
        stages: StageRunner,
    ) -> None:
        self._normalize = normalize
        self._music = music
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
            lambda: providers.separation.separate(
                normalized,
                workspace / "separation",
                context.cancel,
                execution=execution,
            ),
            progress=0.42,
        )
        self._stages.run(
            "ReferenceVocalPreparation",
            CancellationPolicy.FINISH_BEFORE_CANCEL,
            reports,
            context,
            lambda: self._reference.validate(separated.reference_vocal),
            progress=0.48,
        )
        return separated.instrumental, separated.reference_vocal
