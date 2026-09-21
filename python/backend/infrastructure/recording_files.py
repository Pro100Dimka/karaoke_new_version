from __future__ import annotations

from pathlib import Path

from backend.domain_errors import DependencyError, DomainError
from backend.infrastructure.atomic_files import atomic_write_text
from backend.infrastructure.paths import ensure_within
from backend.recordings.domain import Recording
from backend.serialization import dumps, loads_object
from backend.storage.domain import StorageRoots


class LocalRecordingStorage:
    def __init__(self, roots: StorageRoots) -> None:
        self._root = roots.recordings.resolve()
        self._quarantine = roots.quarantine.resolve() / "recordings"

    def allocate_target(self, recording_id: str, suffix: str) -> Path:
        safe_suffix = suffix.lower() if suffix.lower() in {".wav", ".flac"} else ".wav"
        target = self._root / recording_id / f"recording{safe_suffix}"
        target.parent.mkdir(parents=True, exist_ok=True)
        return target

    def validate_owned_file(self, path: Path) -> Path:
        resolved = ensure_within(path, self._root)
        if not resolved.is_file():
            raise DomainError("RecordingNotFound", "Finalized recording file does not exist", 404)
        return resolved

    def write_recovery_descriptor(self, recording: Recording) -> Path:
        target = recording.file_path.parent / "recording-recovery.json"
        atomic_write_text(target, dumps(_payload(recording), pretty=True))
        return target

    def remove_recovery_descriptor(self, recording_id: str) -> None:
        (self._root / recording_id / "recording-recovery.json").unlink(missing_ok=True)

    def recovery_descriptors(self) -> tuple[Path, ...]:
        return tuple(self._root.glob("*/recording-recovery.json"))

    def quarantine(self, recording_id: str, file_path: Path) -> Path:
        source = self.validate_owned_file(file_path)
        target = self._quarantine / recording_id / source.name
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            source.replace(target)
        except OSError as exc:
            raise DependencyError("StorageUnavailable", "Recording quarantine failed") from exc
        return target

    def restore_quarantine(self, quarantine_path: Path, target: Path) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        quarantine_path.replace(target)

    def finalize_quarantine(self, quarantine_path: Path) -> None:
        quarantine_path.unlink(missing_ok=True)
        try:
            quarantine_path.parent.rmdir()
        except OSError:
            return

    def read_recovery_descriptor(self, path: Path) -> dict[str, object]:
        try:
            return loads_object(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise DomainError(
                "RecordingRecoveryInvalid", "Recording recovery descriptor is invalid", 400
            ) from exc


def _payload(recording: Recording) -> dict[str, object]:
    return {
        "recordingId": recording.recording_id,
        "filePath": str(recording.file_path),
        "duration": recording.duration,
        "sampleRate": recording.sample_rate,
        "channels": recording.channels,
        "createdAt": recording.created_at.isoformat(),
        "songId": recording.song_id,
        "songRevision": recording.song_revision,
        "gaps": list(recording.gaps),
        "sessionMetadata": dict(recording.session_metadata or {}),
    }
