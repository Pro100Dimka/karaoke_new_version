from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from backend.recordings.ports import RecordingStorage
from backend.runtime import IdGenerator


@dataclass(frozen=True, slots=True)
class RecordingTarget:
    recording_id: str
    file_path: Path


def allocate_recording_target(storage: RecordingStorage, ids: IdGenerator) -> RecordingTarget:
    recording_id = ids.new()
    return RecordingTarget(recording_id, storage.allocate_target(recording_id, ".wav"))
