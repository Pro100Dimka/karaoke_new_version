from __future__ import annotations

import logging
import os
import shutil
import threading
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path

import numpy as np
import soundfile as sf

from backend.analysis.domain import AnalysisResult, AnalysisState
from backend.domain_errors import ConflictError
from backend.infrastructure.atomic_files import atomic_write_text
from backend.infrastructure.job_executor import ServiceLoop
from backend.infrastructure.hashing import sha256_file
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
    """Publish verified MP3 pairs before removing the working audio; resume from a disk marker."""

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
        self._resumed = False
        self._loop = ServiceLoop("recording-archive", self._step, 5)

    def start(self) -> None:
        self._loop.start()

    def stop(self) -> None:
        self._cancel.set()
        self._wake.set()
        self._loop.stop()

    def request(self, recording_id: str) -> None:
        # Storage errors must not turn a successful Master or analysis into a failed job.
        try:
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
                if all(item.file_path.suffix.lower() == ".mp3" for item in (source, master)):
                    continue
                marker = self._path(master).parent / "archive-pending.json"
                with self._lock:
                    atomic_write_text(
                        marker, dumps({"sourceId": source_id, "masterId": master.recording_id})
                    )
                    self._pending.add(marker)
            self._wake.set()
        except Exception:
            logger.exception(
                "Could not schedule recording archive", extra={"recordingId": recording_id}
            )

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
        try:
            if not self._resumed:
                with self._lock:
                    self._pending.update(self._root.glob("*/archive-pending.json"))
                self._resumed = True
            with self._lock:
                markers = tuple(self._pending)
            for marker in markers:
                if self._cancel.is_set():
                    return
                try:
                    if self._archive(marker):
                        with self._lock:
                            self._pending.discard(marker)
                except ConflictError:
                    pass  # Active jobs still own the WAV files; retry after they finish.
                except Exception:
                    if not self._cancel.is_set():
                        logger.exception(
                            "Recording archive deferred; working audio retained",
                            extra={"marker": str(marker)},
                        )
        except Exception:
            logger.exception("Recording archive recovery deferred")
        self._wake.wait(5)
        self._wake.clear()

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
        converted = [(item, self._encode(self._path(item))) for item in (source, master)]
        if self._cancel.is_set():
            return False

        def publish() -> None:
            latest = self._analyses(source_id)
            if (
                self._cancel.is_set()
                or not latest
                or latest[0].state is not AnalysisState.SUCCEEDED
            ):
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
                    working.unlink(missing_ok=True)
            marker.unlink(missing_ok=True)

        self._when_idle(publish)
        return True

    def _encode(self, source: Path) -> Path:
        target = source.with_name("recording.mp3")
        if target.resolve() != target:
            raise ValueError("MP3 target cannot be an alias")
        info = sf.info(source)
        if info.channels not in {1, 2} or info.frames <= 0:
            raise ValueError("MP3 requires a nonempty mono or stereo recording")
        rate = min(
            (8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000),
            key=lambda value: abs(value - info.samplerate),
        )
        expected_frames = info.frames * rate / info.samplerate
        cache = target.with_suffix(".mp3.peaks.json")
        if target.is_file() and cache.is_file():
            saved = loads_object(cache.read_text(encoding="utf-8"))
            stat = target.stat()
            if saved.get("size") == stat.st_size and saved.get("sha256") == sha256_file(target):
                encoded = sf.info(target)
                if (
                    encoded.frames > 0
                    and (encoded.samplerate, encoded.channels) == (rate, info.channels)
                    and abs(encoded.frames - expected_frames) <= 1
                ):
                    return target
        temporary = target.with_suffix(".archiving.mp3")
        try:
            if source != target:
                if shutil.disk_usage(source.parent).free < info.duration * 40000 + 32 * 1024 * 1024:
                    raise OSError("Insufficient space for a verified MP3 copy")
                result = self._runner.run(
                    [
                        "ffmpeg",
                        "-v",
                        "error",
                        "-nostdin",
                        "-y",
                        "-i",
                        str(source),
                        "-map",
                        "0:a:0",
                        "-c:a",
                        "libmp3lame",
                        "-ar",
                        str(rate),
                        "-b:a",
                        "320k",
                        str(temporary),
                    ],
                    timeout_seconds=max(60, info.duration * 2),
                    cancel=self._cancel,
                )
                if result.exit_code:
                    raise ValueError("MP3 encoding failed")
            encoded = temporary if source != target else target
            peaks = np.zeros(4096)
            frames = 0
            with sf.SoundFile(encoded) as audio:
                if (
                    audio.frames <= 0
                    or (audio.samplerate, audio.channels) != (rate, info.channels)
                    or abs(audio.frames - expected_frames) > 1
                ):
                    raise ValueError("Encoded MP3 has different duration or audio layout")
                total_frames = audio.frames
                for block in audio.blocks(blocksize=65536, dtype="float32", always_2d=True):
                    if self._cancel.is_set():
                        raise InterruptedError("Recording archive stopped")
                    if not np.isfinite(block).all():
                        raise ValueError("Encoded MP3 contains invalid samples")
                    slots = np.arange(frames, frames + len(block)) * len(peaks) // total_frames
                    np.maximum.at(peaks, slots, np.abs(block).max(axis=1))
                    frames += len(block)
            if frames != total_frames:
                raise ValueError("Encoded MP3 is incomplete")
            if source != target:
                with temporary.open("r+b") as stream:
                    os.fsync(stream.fileno())
                os.replace(temporary, target)
            stat = target.stat()
            atomic_write_text(
                cache,
                dumps(
                    {
                        "size": stat.st_size,
                        "sha256": sha256_file(target),
                        "peaks": np.round(peaks / (float(peaks.max()) or 1), 3).tolist(),
                    }
                ),
            )
            return target
        finally:
            temporary.unlink(missing_ok=True)
