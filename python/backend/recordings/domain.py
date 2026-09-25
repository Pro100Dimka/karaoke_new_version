from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Mapping, Sequence

from backend.domain_errors import DomainError
from backend.storage.path_policy import portable_component


def validate_recording_id(recording_id: str) -> str:
    try:
        return portable_component(recording_id)
    except ValueError as exc:
        raise DomainError("InvalidRecording", "Recording ID must be a safe path component", 400) from exc


@dataclass(frozen=True, slots=True)
class Recording:
    recording_id: str
    file_path: Path
    duration: float
    sample_rate: int
    channels: int
    created_at: datetime
    song_id: str | None = None
    song_revision: int | None = None
    gaps: Sequence[Mapping[str, float]] = ()
    session_metadata: Mapping[str, object] | None = None
    display_name: str | None = None
    file_status: str = "Ready"
