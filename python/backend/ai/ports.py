from __future__ import annotations

import threading
from pathlib import Path
from typing import Protocol, Sequence

from backend.ai.domain import AiProviderDescriptor, PitchPoint, SeparatedAudio, WordTiming
from backend.songs.domain import Language
from backend.processing.compute_policy import ExecutionContext


class AiProvider(Protocol):
    @property
    def descriptor(self) -> AiProviderDescriptor: ...

    def separate(
        self, audio: Path, workdir: Path, cancel: threading.Event, *, execution: ExecutionContext
    ) -> SeparatedAudio: ...

    def transcribe(
        self,
        vocal: Path,
        language: Language,
        cancel: threading.Event,
        *,
        execution: ExecutionContext,
    ) -> str: ...

    # Every stage receives the admitted device and its share of the job's CPU budget.
    def align(
        self,
        vocal: Path,
        lyrics: str,
        language: Language,
        cancel: threading.Event,
        *,
        execution: ExecutionContext,
    ) -> Sequence[WordTiming]: ...

    def pitch(
        self, vocal: Path, cancel: threading.Event, *, execution: ExecutionContext
    ) -> Sequence[PitchPoint]: ...
