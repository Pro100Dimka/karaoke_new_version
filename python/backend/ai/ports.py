from __future__ import annotations

import threading
from contextlib import AbstractContextManager
from pathlib import Path
from typing import Callable, Iterable, Protocol, Sequence, runtime_checkable

from backend.ai.domain import AiProviderDescriptor, PitchPoint, SeparatedAudio, WordTiming
from backend.lyrics.ports import LyricLineTiming
from backend.songs.domain import Language
from backend.processing.compute_policy import ExecutionContext

TranscriptionSource = Callable[[threading.Event], Iterable[tuple[Path, float]]]


@runtime_checkable
class AlignmentReuseProvider(Protocol):
    def reuse_alignment(
        self, workdir: Path, cancel: threading.Event
    ) -> AbstractContextManager[None]: ...


@runtime_checkable
class StreamingTranscriber(Protocol):
    def transcribe_stream(
        self,
        requests: TranscriptionSource,
        request_count: int,
        language: Language,
        cancel: threading.Event,
        *,
        execution: ExecutionContext,
    ) -> Sequence[str]: ...


@runtime_checkable
class BatchTranscriber(Protocol):
    def transcribe_many(
        self,
        requests: Sequence[tuple[Path, float]],
        language: Language,
        cancel: threading.Event,
        *,
        execution: ExecutionContext,
    ) -> Sequence[str]: ...


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
        start_seconds: float = 0.0,
    ) -> str: ...

    # Every stage receives the admitted device and its share of the job's CPU budget.
    def align(
        self,
        vocal: Path,
        lyrics: str,
        language: Language,
        cancel: threading.Event,
        *,
        timing_hints: Sequence[LyricLineTiming] = (),
        execution: ExecutionContext,
        instrumental: Path | None = None,
    ) -> Sequence[WordTiming]: ...

    def pitch(
        self, vocal: Path, cancel: threading.Event, *, execution: ExecutionContext
    ) -> Sequence[PitchPoint]: ...
