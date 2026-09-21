from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from backend.recordings.ports import RecordingStorage
from backend.runtime import IdGenerator


@dataclass(frozen=True, slots=True)
class RecordingTarget:
    recording_id: str
    file_path: Path


class AllocateRecordingTarget:
    def __init__(self, storage: RecordingStorage, ids: IdGenerator) -> None:
        self._storage = storage
        self._ids = ids

    def execute(self) -> RecordingTarget:
        recording_id = self._ids.new()
        return RecordingTarget(recording_id, self._storage.allocate_target(recording_id, ".wav"))
