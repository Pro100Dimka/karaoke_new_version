from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Mapping, Sequence


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
