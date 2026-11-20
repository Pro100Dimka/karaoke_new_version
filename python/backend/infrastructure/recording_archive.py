from __future__ import annotations
from functools import partial

import logging
import threading
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path

import soundfile as sf

from backend.domain_errors import ConflictError
from backend.infrastructure.atomic_files import atomic_write_text
from backend.infrastructure.job_executor import ServiceLoop, job_failure
from backend.infrastructure.paths import ensure_within
from backend.infrastructure.process_runner import ProcessRunner
from backend.infrastructure.recording_audio import compact_recording
from backend.infrastructure.recording_sources import (
    PreparedSource,
    prepare_dry_archive,
    retire_dry_archive,
)
from backend.persistence import UnitOfWorkFactory
from backend.recordings.domain import Recording, validate_recording_id
from backend.recordings.ports import RecordingFileMetadata
from backend.serialization import dumps, loads_object

logger = logging.getLogger(__name__)
_WORKING_FILES = (
    "recording.wav",
    "recording.flac",
    "recording.mp3",
)
_ARCHIVE_VERSION = 1


class RecordingArchive:
    """Archive listening mixes while retaining separate sources for subsequent mastering."""

    def __init__(
        self,
        root: Path,
        uow: UnitOfWorkFactory,
        runner: ProcessRunner,
        when_idle: Callable[[Callable[[], None]], None],
    ) -> None:
        self._root = root.resolve()
        self._uow = uow
        self._runner = runner
        self._when_idle = when_idle
        self._cancel = threading.Event()
        self._wake = threading.Event()
        self._lock = threading.Lock()
        self._pending: set[Path] = set()
        self._backfilled = False
        self._loop = ServiceLoop("recording-archive", self._step, 5)

    def start(self) -> None:
        self._loop.start()

    def stop(self) -> None:
        self._cancel.set()
        self._wake.set()
        self._loop.stop()

    def request(self, recording_id: str) -> None:
        # Registration and mastering only queue work; encoding never delays readiness.
        with job_failure(
            partial(
                logger.exception,
                "Could not schedule recording archive",
                extra={"recordingId": recording_id},
            ),
            suppress=True,
        ):
            with self._uow.create() as transaction:
                recording = transaction.recordings.get(recording_id)
            if recording is None or recording.file_status != "Ready":
                return
            self._queue(recording)
            self._wake.set()

    def _queue(self, recording: Recording) -> None:
        marker = self._path(recording).parent / "archive-pending.json"
        with self._lock:
            if not marker.exists():
                if self._completed(recording):
                    return
                atomic_write_text(marker, dumps({"recordingId": recording.recording_id}))
            self._pending.add(marker)

    @staticmethod
    def _source_id(recording: Recording) -> str | None:
        master = (recording.session_metadata or {}).get("studioMaster")
        source = master.get("sourceRecordingId") if isinstance(master, Mapping) else None
        return source if isinstance(source, str) and source else None

    def _path(self, recording: Recording) -> Path:
        path = ensure_within(recording.file_path, self._root)
        directory = self._root / validate_recording_id(recording.recording_id)
        if path.parent != directory or directory.resolve() != directory:
            raise ValueError("Recording archive cannot follow directory aliases")
        return path

    def _step(self) -> None:
        with job_failure(
            partial(logger.exception, "Recording archive recovery deferred"), suppress=True
        ):
            if not self._backfilled:
                self._backfill()
                self._backfilled = True
            with self._lock:
                markers = tuple(self._pending)
            for marker in markers:
                if self._cancel.is_set():
                    return
                self._archive_one(marker)
        self._wake.wait(5)
        self._wake.clear()

    def _backfill(self) -> None:
        # Only registered Ready rows are eligible; live or recovered native captures stay intact.
        offset = 0
        while not self._cancel.is_set():
            with self._uow.create() as transaction:
                recordings = transaction.recordings.list(song_id=None, limit=200, offset=offset)
            for recording in recordings:
                self.request(recording.recording_id)
            if len(recordings) < 200:
                return
            offset += len(recordings)

    def _archive_one(self, marker: Path) -> None:
        with job_failure(partial(self._archive_failed, marker), suppress=True):
            try:
                if self._archive(marker):
                    with self._lock:
                        self._pending.discard(marker)
            except ConflictError:
                pass  # Active jobs still own the WAV files; retry after they finish.
            except ValueError as exc:
                # Invalid audio will not become valid on the next 5-second tick.
                # Preserve all working files and quarantine only the retry marker.
                logger.warning(
                    "Recording archive paused for invalid audio: %s",
                    exc,
                    extra={"marker": str(marker)},
                )
                with self._lock:
                    if marker.is_file():
                        marker.replace(marker.with_name("archive-invalid.json"))
                    self._pending.discard(marker)

    def _archive_failed(self, marker: Path) -> None:
        if not self._cancel.is_set():
            logger.exception(
                "Recording archive deferred; working audio retained",
                extra={"marker": str(marker)},
            )

    def _archive(self, marker: Path) -> bool:
        if not marker.exists():
            return True
        recording = self._pending_recording(marker)
        if recording is None:
            marker.unlink(missing_ok=True)
            return True
        if recording.file_status != "Ready":
            return False
        # Encoding only reads finalized audio. Publication/removal shares the job submission lock.
        self._when_idle(lambda: None)
        source = self._path(recording)
        self._validate_audio(source)
        master = self._source_id(recording) is not None
        prepared = None if master else prepare_dry_archive(source, self._cancel)
        target = (
            source
            if self._completed(recording)
            else compact_recording(source, self._runner, self._cancel, master=master)
        )
        if self._cancel.is_set():
            return False
        self._when_idle(
            partial(
                self._publish,
                recording.recording_id,
                [(recording, target)],
                marker,
                sources=() if prepared is None else (prepared,),
            )
        )
        return True

    def _pending_recording(self, marker: Path) -> Recording | None:
        if ensure_within(marker, self._root) != marker:
            raise ValueError("Recording archive marker cannot be an alias")
        payload = loads_object(marker.read_text(encoding="utf-8"))
        # Existing pending Master/source markers remain resumable after an upgrade.
        recording_id = payload.get("recordingId", payload.get("masterId"))
        if not isinstance(recording_id, str) or not recording_id:
            raise ValueError("Recording archive marker has no recording identity")
        with self._uow.create() as transaction:
            recording = transaction.recordings.get(validate_recording_id(recording_id))
        if recording is not None and marker.parent != self._path(recording).parent:
            raise ValueError("Recording archive marker belongs to another recording")
        return recording

    def _publish(
        self,
        source_id: str,
        converted: list[tuple[Recording, Path]],
        marker: Path,
        sources: Sequence[PreparedSource] = (),
    ) -> None:
        if self._cancel.is_set():
            raise ConflictError("RecordingChanged", "Recording archival was cancelled")
        self._commit_files(converted)
        # A failed Windows unlink must resume cleanup without encoding the valid replacement again.
        for _, path in converted:
            atomic_write_text(path.parent / "archive-complete.json", dumps(self._completion(path)))
        for prepared in sources:
            retire_dry_archive(prepared)
        self._cleanup(converted)
        marker.unlink(missing_ok=True)

    def _commit_files(self, converted: list[tuple[Recording, Path]]) -> None:
        with self._uow.create() as transaction:
            for previous, path in converted:
                current = transaction.recordings.get(previous.recording_id)
                if (
                    current is None
                    or current.file_status != "Ready"
                    or current.file_path != previous.file_path
                ):
                    raise ConflictError("RecordingChanged", "Recording changed during archival")
                if (
                    path.parent != previous.file_path.parent
                    or ensure_within(path, path.parent) != path
                ):
                    raise ValueError("Recording replacement must stay in its owned directory")
                info = sf.info(path)
                transaction.recordings.update_file(
                    current.recording_id,
                    path,
                    RecordingFileMetadata(info.duration, info.samplerate, info.channels),
                )
            transaction.commit()

    @staticmethod
    def _cleanup(converted: list[tuple[Recording, Path]]) -> None:
        for previous, path in converted:
            obsolete = {previous.file_path, *(path.parent / name for name in _WORKING_FILES)}
            for working in obsolete - {path}:
                # Retain dry/wet/backing sources and legacy recording.original.wav for remastering.
                for candidate in (
                    working,
                    Path(str(working) + ".peaks.json"),
                    Path(str(working) + ".archive.json"),
                ):
                    if candidate.resolve() != candidate:
                        raise ValueError("Recording cleanup cannot follow file aliases")
                    candidate.unlink(missing_ok=True)

    def _completed(self, recording: Recording) -> bool:
        path = self._path(recording)
        try:
            saved = loads_object(
                (path.parent / "archive-complete.json").read_text(encoding="utf-8")
            )
            return saved == self._completion(path)
        except (OSError, ValueError):
            return False

    @staticmethod
    def _completion(path: Path) -> dict[str, object]:
        info = path.stat()
        return {
            "version": _ARCHIVE_VERSION,
            "file": path.name,
            "size": info.st_size,
            "modifiedNs": info.st_mtime_ns,
            "changedNs": info.st_ctime_ns,
            "device": info.st_dev,
            "inode": info.st_ino,
        }

    @staticmethod
    def _validate_audio(source: Path) -> None:
        if not source.is_file():
            raise ValueError(f"Recording audio is missing: {source.name}")
        try:
            info = sf.info(source)
        except (OSError, RuntimeError) as exc:
            raise ValueError(f"Recording audio cannot be decoded: {source.name}") from exc
        if not 1 <= info.channels <= 8 or info.frames <= 0 or info.samplerate <= 0:
            raise ValueError(
                f"Recording audio is empty or has an unsupported layout: {source.name}"
            )
