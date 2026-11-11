from __future__ import annotations
from functools import partial

import logging
import threading
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path

import soundfile as sf

from backend.analysis.domain import AnalysisResult, AnalysisState
from backend.domain_errors import ConflictError
from backend.infrastructure.atomic_files import atomic_write_text
from backend.infrastructure.job_executor import ServiceLoop, job_failure
from backend.infrastructure.lossless_audio import compress_audio
from backend.infrastructure.paths import ensure_within
from backend.infrastructure.process_runner import ProcessRunner
from backend.persistence import UnitOfWorkFactory
from backend.recordings.domain import Recording, validate_recording_id
from backend.recordings.ports import RecordingFileMetadata
from backend.serialization import dumps, loads_object

logger = logging.getLogger(__name__)
_WORKING_FILES = (
    "recording.wav",
    "recording.flac",
    "recording.original.wav",
    "recording.wav.backing.wav",
    "recording.wav.vocal.wav",
    "recording.wav.dry.wav",
    "recording.wav.dry-incomplete.wav",
)


class RecordingArchive:
    """Publish lossless pairs before removing working stems; resume from a disk marker."""

    def __init__(
        self,
        root: Path,
        uow: UnitOfWorkFactory,
        runner: ProcessRunner,
        analyses: Callable[[str], Sequence[AnalysisResult]],
        when_idle: Callable[[Callable[[], None]], None],
    ) -> None:
        self._root = root.resolve()
        self._uow = uow
        self._runner = runner
        self._analyses = analyses
        self._when_idle = when_idle
        self._cancel = threading.Event()
        self._wake = threading.Event()
        self._lock = threading.Lock()
        self._pending: set[Path] = set()
        self._loop = ServiceLoop("recording-archive", self._step, 5)

    def start(self) -> None:
        self._loop.start()

    def stop(self) -> None:
        self._cancel.set()
        self._wake.set()
        self._loop.stop()

    def request(self, recording_id: str) -> None:
        # Storage errors must not turn a successful Master or analysis into a failed job.
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
                if recording is None:
                    return
                source_id = self._source_id(recording) or recording_id
                source = transaction.recordings.get(source_id)
                if source is None:
                    return
                count = transaction.recordings.count(song_id=source.song_id)
                masters = transaction.recordings.list(song_id=source.song_id, limit=count, offset=0)
            for master in masters:
                if self._source_id(master) != source_id or master.file_status != "Ready":
                    continue
                marker = self._path(master).parent / "archive-pending.json"
                with self._lock:
                    atomic_write_text(
                        marker, dumps({"sourceId": source_id, "masterId": master.recording_id})
                    )
                    self._pending.add(marker)
            self._wake.set()

    @staticmethod
    def _source_id(recording: Recording) -> str | None:
        master = (recording.session_metadata or {}).get("studioMaster")
        source = master.get("sourceRecordingId") if isinstance(master, Mapping) else None
        return source if isinstance(source, str) else None

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
            # Do not scan historical markers at startup: archival is scheduled
            # only for completed Masters through request().
            with self._lock:
                markers = tuple(self._pending)
            for marker in markers:
                if self._cancel.is_set():
                    return
                self._archive_one(marker)
        self._wake.wait(5)
        self._wake.clear()

    def _archive_one(self, marker: Path) -> None:
        with job_failure(partial(self._archive_failed, marker), suppress=True):
            try:
                if self._archive(marker):
                    with self._lock:
                        self._pending.discard(marker)
            except ConflictError:
                pass  # Active jobs still own the WAV files; retry after they finish.
            except (ValueError, OSError) as exc:
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
        ensure_within(marker, self._root)
        payload = loads_object(marker.read_text(encoding="utf-8"))
        source_id, master_id = str(payload["sourceId"]), str(payload["masterId"])
        with self._uow.create() as transaction:
            source = transaction.recordings.get(source_id)
            master = transaction.recordings.get(master_id)
        if source is None or master is None:
            marker.unlink(missing_ok=True)
            return True
        if marker.parent != self._path(master).parent or self._source_id(master) != source_id:
            raise ValueError("Recording archive marker does not match its Master")
        analyses = self._analyses(source_id)
        if (
            any(item.file_status != "Ready" for item in (source, master))
            or not analyses
            or analyses[0].state is not AnalysisState.SUCCEEDED
        ):
            return False
        # Encoding only reads finalized audio. Publication/removal shares the job submission lock.
        self._when_idle(lambda: None)
        # Validate the complete pair before encoding either file.
        for item in (source, master):
            self._validate_audio(self._path(item))
        converted = [(item, self._encode(self._path(item))) for item in (source, master)]
        if self._cancel.is_set():
            return False

        self._when_idle(partial(self._publish, source_id, converted, marker))
        return True

    def _publish(
        self, source_id: str, converted: list[tuple[Recording, Path]], marker: Path
    ) -> None:
        latest = self._analyses(source_id)
        if self._cancel.is_set() or not latest or latest[0].state is not AnalysisState.SUCCEEDED:
            raise ConflictError("RecordingChanged", "Recording analysis is not complete")
        with self._uow.create() as transaction:
            for previous, path in converted:
                current = transaction.recordings.get(previous.recording_id)
                if (
                    current is None
                    or current.file_status != "Ready"
                    or current.file_path != previous.file_path
                ):
                    raise ConflictError("RecordingChanged", "Recording changed during archival")
                info = sf.info(path)
                transaction.recordings.update_file(
                    current.recording_id,
                    path,
                    RecordingFileMetadata(info.duration, info.samplerate, info.channels),
                )
            transaction.commit()
        for _, path in converted:
            for name in _WORKING_FILES:
                working = path.parent / name
                if working.resolve() != working:
                    raise ValueError("Recording cleanup cannot follow file aliases")
                if working != path:
                    working.unlink(missing_ok=True)
        marker.unlink(missing_ok=True)

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

    def _encode(self, source: Path) -> Path:
        return compress_audio(source, self._runner, self._cancel)
