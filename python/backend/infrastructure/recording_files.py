from __future__ import annotations

from pathlib import Path
import ctypes
import os
import shutil
import struct
from ctypes import wintypes
from typing import BinaryIO
import soundfile as sf

if os.name == "nt":
    import msvcrt

from backend.domain_errors import ConflictError, DependencyError, DomainError
from backend.infrastructure.atomic_files import atomic_write_text
from backend.infrastructure.paths import ensure_within
from backend.recordings.domain import Recording, validate_recording_id
from backend.recordings.ports import RecordingFileMetadata
from backend.serialization import dumps, loads_object
from backend.storage.domain import StorageRoots


def _recording_directory(root: Path, recording_id: str) -> Path:
    return ensure_within(root / validate_recording_id(recording_id), root)


def _empty_native_wav(path: Path) -> bool:
    # Accept only an empty native WAV, with no active writer holding it open.
    with (_open_stopped_recording(path) if os.name == "nt" else path.open("rb")) as stream:
        header = stream.read(45)
    if not header:
        return True
    return (len(header) == 44 and header[:4] == b"RIFF" and header[8:16] == b"WAVEfmt "
            and header[16:20] == struct.pack("<I", 16) and header[36:40] == b"data"
            and struct.unpack_from("<H", header, 20)[0] in {1, 3}
            and struct.unpack_from("<I", header, 4)[0] in {0, 36}
            and header[40:44] == bytes(4))


class LocalRecordingStorage:
    def __init__(self, roots: StorageRoots) -> None:
        self._root = roots.recordings.resolve()
        self._quarantine = roots.quarantine.resolve() / "recordings"

    def allocate_target(self, recording_id: str, suffix: str) -> Path:
        safe_suffix = suffix.lower() if suffix.lower() in {".wav", ".flac"} else ".wav"
        target = _recording_directory(self._root, recording_id) / f"recording{safe_suffix}"
        target.parent.mkdir(parents=True, exist_ok=True)
        return target

    def discard_empty_target(self, recording_id: str) -> bool:
        directory = self._root / validate_recording_id(recording_id)
        if directory.resolve() != directory:
            raise DomainError("InvalidRecording", "Recording target cannot be an alias", 400)
        try:
            if not directory.exists():
                return False
            target = directory / "recording.wav"
            if target.resolve() != target:
                raise DomainError("InvalidRecording", "Recording file cannot be an alias", 400)
            descriptor = directory / "recording-recovery.json"
            backing = directory / "recording.wav.backing.wav"
            vocal = directory / "recording.wav.vocal.wav"
            dry = directory / "recording.wav.dry.wav"
            incomplete_dry = directory / "recording.wav.dry-incomplete.wav"
            children = tuple(directory.iterdir())
            if any(child not in {target, backing, vocal, dry, incomplete_dry, descriptor} for child in children) or any(
                file.exists() and (file.resolve() != file or not _empty_native_wav(file))
                for file in (target, backing, vocal, dry, incomplete_dry)
            ):
                raise ConflictError(
                    "RecordingNotEmpty",
                    "Unregistered recording contains data; keep it for recovery",
                )
            target.unlink(missing_ok=True)
            backing.unlink(missing_ok=True)
            vocal.unlink(missing_ok=True)
            dry.unlink(missing_ok=True)
            incomplete_dry.unlink(missing_ok=True)
            descriptor.unlink(missing_ok=True)
            directory.rmdir()
            return True
        except OSError as exc:
            raise DependencyError("StorageUnavailable", "Empty recording cleanup failed") from exc

    def validate_owned_file(self, path: Path) -> Path:
        resolved = ensure_within(path, self._root)
        if not resolved.is_file():
            raise DomainError("RecordingNotFound", "Finalized recording file does not exist", 404)
        return resolved

    def publish_file(self, recording_id: str, source: Path) -> Path:
        target = self.allocate_target(recording_id, source.suffix)
        temporary = target.with_name(f".{target.name}.publishing")
        try:
            shutil.copy2(source, temporary)
            os.replace(temporary, target)
        except OSError as exc:
            temporary.unlink(missing_ok=True)
            raise DependencyError("StorageUnavailable", "Studio master publication failed") from exc
        return target

    def write_recovery_descriptor(self, recording: Recording) -> Path:
        target = recording.file_path.parent / "recording-recovery.json"
        atomic_write_text(target, dumps(_payload(recording), pretty=True))
        return target

    def remove_recovery_descriptor(self, recording_id: str) -> None:
        (_recording_directory(self._root, recording_id) / "recording-recovery.json").unlink(
            missing_ok=True
        )

    def recovery_descriptors(self) -> tuple[Path, ...]:
        return tuple(self._root.glob("*/recording-recovery.json"))

    def quarantine(self, recording_id: str, file_path: Path) -> Path:
        source = ensure_within(file_path, self._root)
        if source.parent != _recording_directory(self._root, recording_id):
            raise DomainError("InvalidRecording", "Recording belongs to another directory", 400)
        target = self.quarantine_path(recording_id, source)
        target.parent.parent.mkdir(parents=True, exist_ok=True)
        try:
            source.parent.replace(target.parent)
        except OSError as exc:
            raise DependencyError("StorageUnavailable", "Recording quarantine failed") from exc
        return target

    def quarantine_path(self, recording_id: str, file_path: Path) -> Path:
        return _recording_directory(self._quarantine, recording_id) / file_path.name

    def restore_quarantine(self, quarantine_path: Path, target: Path) -> None:
        ensure_within(quarantine_path, self._quarantine)
        ensure_within(target, self._root)
        target.parent.parent.mkdir(parents=True, exist_ok=True)
        quarantine_path.parent.replace(target.parent)

    def finalize_quarantine(self, quarantine_path: Path) -> None:
        directory = ensure_within(quarantine_path, self._quarantine).parent
        validate_recording_id(directory.name)
        shutil.rmtree(directory)

    def read_recovery_descriptor(self, path: Path) -> dict[str, object]:
        try:
            return loads_object(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise DomainError(
                "RecordingRecoveryInvalid", "Recording recovery descriptor is invalid", 400
            ) from exc

    def recover_file(self, path: Path) -> RecordingFileMetadata:
        path = self.validate_owned_file(path)
        # Exclusive access is essential: Python can restart while native capture is still alive.
        with _open_stopped_recording(path) as stream:
            header = stream.read(44)
            if (len(header) != 44 or header[:4] != b"RIFF" or header[8:16] != b"WAVEfmt "
                    or header[36:40] != b"data" or struct.unpack_from("<I", header, 16)[0] != 16):
                # Balancing may have already published a finalized WAV with additional chunks.
                stream.seek(0)
                try:
                    info = sf.info(stream)
                except (OSError, RuntimeError) as error:
                    raise DomainError("InvalidRecording", "Unsupported recording header", 400) from error
                if info.frames <= 0 or info.samplerate <= 0 or info.channels <= 0:
                    raise DomainError("InvalidRecording", "No recoverable recording frames", 400)
                return RecordingFileMetadata(info.frames / info.samplerate, info.samplerate, info.channels)
            encoding, channels, rate, byte_rate, block, bits = struct.unpack_from("<HHIIHH", header, 20)
            if (encoding not in {1, 3} or channels < 1 or rate < 1 or bits not in {16, 32}
                    or block != channels * bits // 8 or byte_rate != rate * block
                    or (encoding == 3 and bits != 32)):
                raise DomainError("InvalidRecording", "Invalid native recording format", 400)
            size = os.fstat(stream.fileno()).st_size - 44
            complete_bytes = size - size % block
            if complete_bytes <= 0 or complete_bytes > 0xFFFFFFFF - 36:
                raise DomainError("InvalidRecording", "No recoverable recording frames", 400)
            # Keep the captured bytes intact; only repair the two RIFF lengths.
            for offset, value in ((4, 36 + complete_bytes), (40, complete_bytes)):
                stream.seek(offset)
                stream.write(struct.pack("<I", value))
            stream.flush()
            os.fsync(stream.fileno())
            return RecordingFileMetadata(complete_bytes / block / rate, rate, channels)


def _open_stopped_recording(path: Path) -> BinaryIO:
    if os.name != "nt":
        # Desktop capture is Windows-only; do not repair a potentially live foreign capture.
        raise OSError("Recording recovery requires exclusive Windows file access")
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = (
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
        wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
    )
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    handle = kernel.CreateFileW(str(path), 0xC0000000, 0, None, 3, 0x80, None)
    if handle == wintypes.HANDLE(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        fd = msvcrt.open_osfhandle(handle, os.O_RDWR | os.O_BINARY | os.O_NOINHERIT)
    except OSError:
        kernel.CloseHandle(handle)
        raise
    return os.fdopen(fd, "r+b")


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
        "displayName": recording.display_name,
    }
