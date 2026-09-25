from __future__ import annotations

import threading
from pathlib import Path
from typing import Sequence

from backend.ai.domain import PitchPoint, SeparatedAudio, WordTiming
from backend.ai.ports import AiProvider
from backend.lyrics.discovery import LyricsDiscovery, LyricsDiscoveryResult
from backend.lyrics.ports import LyricLineTiming
from backend.songs.domain import Song
from backend.processing.compute_policy import ExecutionContext


class SeparationStage:
    def run(
        self,
        audio: Path,
        workspace: Path,
        provider: AiProvider,
        cancel: threading.Event,
        *,
        execution: ExecutionContext,
    ) -> SeparatedAudio:
        return provider.separate(audio, workspace / "separation", cancel, execution=execution)


class LyricsStage:
    def __init__(self, discovery: LyricsDiscovery) -> None:
        self._discovery = discovery

    def run(
        self,
        song: Song,
        reference_vocal: Path,
        asr: AiProvider,
        cancel: threading.Event,
        *,
        online_enabled: bool,
        execution: ExecutionContext,
    ) -> LyricsDiscoveryResult:
        return self._discovery.discover(
            song,
            reference_vocal,
            asr,
            cancel,
            online_enabled=online_enabled,
            execution=execution,
        )


class AlignmentStage:
    def run(
        self,
        vocal: Path,
        lyrics: str,
        song: Song,
        provider: AiProvider,
        cancel: threading.Event,
        *,
        timing_hints: Sequence[LyricLineTiming] = (),
        execution: ExecutionContext,
    ) -> Sequence[WordTiming]:
        return provider.align(
            vocal,
            lyrics,
            song.language,
            cancel,
            timing_hints=timing_hints,
            execution=execution,
        )


class PitchStage:
    def run(
        self,
        vocal: Path,
        provider: AiProvider,
        cancel: threading.Event,
        *,
        execution: ExecutionContext,
    ) -> Sequence[PitchPoint]:
        return provider.pitch(vocal, cancel, execution=execution)
