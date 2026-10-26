from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Mapping, Sequence
from dataclasses import replace
import logging

from backend.domain_errors import ConflictError, DomainError
from backend.recordings.register_recording import RegisterRecording, RegisterRecordingRequest
from backend.recordings.ports import RecordingStorage

logger = logging.getLogger(__name__)


class ReconcileRecordings:
    def __init__(self, storage: RecordingStorage, register: RegisterRecording) -> None:
        self._storage = storage
        self._register = register

    def execute(self, recording_id: str | None = None) -> tuple[str, ...]:
        recovered: list[str] = []
        for descriptor in self._storage.recovery_descriptors():
            if recording_id is not None and descriptor.parent.name != recording_id:
                continue
            try:
                request = _request(self._storage.read_recovery_descriptor(descriptor))
                try:
                    if self._storage.discard_empty_target(request.recording_id):
                        continue
                except ConflictError:
                    pass
                metadata = self._storage.recover_file(request.file_path)
                recording = self._register.execute(
                    replace(request, duration=metadata.duration, sample_rate=metadata.sample_rate,
                            channels=metadata.channels, file_status="RecoveredIncomplete")
                )
                recovered.append(recording.recording_id)
            except (DomainError, OSError, ValueError, TypeError, KeyError) as error:
                if recording_id is not None:
                    raise
                logger.info("Recording recovery deferred: %s: %s", descriptor, error)
                continue
        return tuple(recovered)


def _request(data: dict[str, object]) -> RegisterRecordingRequest:
    return RegisterRecordingRequest(
        recording_id=_text(data, "recordingId"),
        file_path=Path(_text(data, "filePath")),
        duration=_number(data, "duration"),
        sample_rate=_integer(data, "sampleRate"),
        channels=_integer(data, "channels"),
        created_at=datetime.fromisoformat(_text(data, "createdAt")),
        song_id=_optional_text(data.get("songId")),
        song_revision=_optional_integer(data.get("songRevision")),
        gaps=_gaps(data.get("gaps")),
        session_metadata=_mapping(data.get("sessionMetadata")),
        display_name=_optional_text(data.get("displayName")),
    )


def _text(data: Mapping[str, object], key: str) -> str:
    value = data[key]
    if not isinstance(value, str) or not value:
        raise ValueError(f"{key} must be text")
    return value


def _number(data: Mapping[str, object], key: str) -> float:
    value = data[key]
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ValueError(f"{key} must be numeric")
    return float(value)


def _integer(data: Mapping[str, object], key: str) -> int:
    value = data[key]
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{key} must be integer")
    return value


def _optional_text(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _optional_integer(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _mapping(value: object) -> Mapping[str, object] | None:
    return dict(value) if isinstance(value, dict) else None


def _gaps(value: object) -> Sequence[Mapping[str, float]]:
    if not isinstance(value, list):
        return ()
    result: list[Mapping[str, float]] = []
    for item in value:
        if isinstance(item, dict):
            result.append({str(k): float(v) for k, v in item.items() if isinstance(v, int | float)})
    return tuple(result)
