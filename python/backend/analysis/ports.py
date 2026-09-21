from __future__ import annotations

from pathlib import Path
from typing import Protocol, Sequence

from backend.ai.domain import PitchPoint
from backend.analysis.domain import AnalysisResult


class AnalysisRepository(Protocol):
    def get(self, analysis_id: str) -> AnalysisResult | None: ...

    def add(self, result: AnalysisResult) -> None: ...

    def update(self, result: AnalysisResult) -> None: ...

    def list_for_recording(self, recording_id: str) -> Sequence[AnalysisResult]: ...


class RecordingPitchExtractor(Protocol):
    def extract(self, path: Path) -> Sequence[PitchPoint]: ...
