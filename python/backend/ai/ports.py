from __future__ import annotations

import threading
from pathlib import Path
from typing import Protocol, Sequence

from backend.ai.domain import AiProviderDescriptor, PitchPoint, SeparatedAudio, WordTiming
from backend.songs.domain import Language


class AiProvider(Protocol):
    @property
    def descriptor(self) -> AiProviderDescriptor: ...

    def separate(self, audio: Path, workdir: Path, cancel: threading.Event) -> SeparatedAudio: ...

    def transcribe(self, vocal: Path, language: Language, cancel: threading.Event) -> str: ...

    # cpu_threads overrides the descriptor's own required cpuThreads for this one call; the pipeline uses
    # it to shrink each side's share when alignment and pitch analysis run concurrently, instead of both
    # claiming the full budget and oversubscribing the machine. None keeps the provider's own default.
    def align(
        self,
        vocal: Path,
        lyrics: str,
        language: Language,
        cancel: threading.Event,
        *,
        cpu_threads: int | None = None,
    ) -> Sequence[WordTiming]: ...

    def pitch(
        self, vocal: Path, cancel: threading.Event, *, cpu_threads: int | None = None
    ) -> Sequence[PitchPoint]: ...
