from __future__ import annotations

import threading
from pathlib import Path
from typing import Sequence

from backend.ai.domain import PitchPoint, SeparatedAudio, WordTiming
from backend.ai.ports import AiProvider
from backend.lyrics.discovery import LyricsDiscovery, LyricsDiscoveryResult
from backend.songs.domain import Song


class SeparationStage:
    def run(
        self,
        audio: Path,
        workspace: Path,
        provider: AiProvider,
        cancel: threading.Event,
    ) -> SeparatedAudio:
        return provider.separate(audio, workspace / "separation", cancel)


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
    ) -> LyricsDiscoveryResult:
        return self._discovery.discover(
            song,
            reference_vocal,
            asr,
            cancel,
            online_enabled=online_enabled,
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
        cpu_threads: int | None = None,
    ) -> Sequence[WordTiming]:
        return provider.align(vocal, lyrics, song.language, cancel, cpu_threads=cpu_threads)


class PitchStage:
    def run(
        self,
        vocal: Path,
        provider: AiProvider,
        cancel: threading.Event,
        *,
        cpu_threads: int | None = None,
    ) -> Sequence[PitchPoint]:
        return provider.pitch(vocal, cancel, cpu_threads=cpu_threads)
