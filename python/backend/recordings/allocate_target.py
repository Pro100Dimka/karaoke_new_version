from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from backend.recordings.ports import RecordingStorage
from backend.recordings.domain import Recording
from backend.runtime import IdGenerator


@dataclass(frozen=True, slots=True)
class RecordingTarget:
    recording_id: str
    file_path: Path


def allocate_recording_target(
    storage: RecordingStorage, ids: IdGenerator,
    song_id: str | None = None, song_revision: int | None = None,
) -> RecordingTarget:
    recording_id = ids.new()
    path = storage.allocate_target(recording_id, ".wav")
    storage.write_recovery_descriptor(Recording(
        recording_id, path, 0.0, 0, 0, datetime.now(timezone.utc), song_id, song_revision,
        file_status="RecoveredIncomplete",
    ))
    return RecordingTarget(recording_id, path)
