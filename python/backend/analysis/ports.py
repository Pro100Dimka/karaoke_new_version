from __future__ import annotations

from pathlib import Path
from contextlib import AbstractContextManager
from typing import Callable, Protocol, Sequence
import threading

from backend.ai.domain import PitchPoint
from backend.analysis.domain import AnalysisResult


class AnalysisRepository(Protocol):
    def get(self, analysis_id: str) -> AnalysisResult | None: ...

    def add(self, result: AnalysisResult) -> None: ...

    def update(self, result: AnalysisResult) -> None: ...

    def list_for_recording(self, recording_id: str) -> Sequence[AnalysisResult]: ...


class RecordingPitchExtractor(Protocol):
    def admit(self, recording: Path, cancel: threading.Event) -> AbstractContextManager[None]: ...

    def extract_vocals(
        self,
        recording: Path,
        reference: Path,
        cancel: threading.Event,
        progress: Callable[[str, float, float], None],
        *,
        reference_start: float | None = 0.0,
    ) -> tuple[Sequence[PitchPoint], Sequence[PitchPoint]]: ...
