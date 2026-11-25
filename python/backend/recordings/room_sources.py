"""Lossless singer sources exchanged after a shared performance."""

from __future__ import annotations

import csv
import hashlib
import shutil
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Mapping

import soundfile as sf

from backend.serialization import dumps, loads_object
from backend.domain_errors import DomainError
from backend.infrastructure.atomic_files import atomic_write_text, replace_with_retry
from backend.infrastructure.hashing import sha256_file
from backend.infrastructure.paths import ensure_within
from backend.recordings.domain import Recording
from backend.room.voice_protocol import VOICE_SAMPLE_RATE_HZ

_FILES = ("metadata.json", "voice.wav", "timeline.csv")


def _invalid(message: str) -> DomainError:
    return DomainError("RoomVocalSourceUnavailable", message, 409)


def _positive_int(metadata: Mapping[str, object], key: str) -> int:
    value = metadata.get(key)
    if type(value) is not int or value <= 0:
        raise _invalid("Singer source format is invalid")
    return value


def _performance(recording: Recording) -> Mapping[str, object]:
    performance = (recording.session_metadata or {}).get("roomPerformance")
    if not isinstance(performance, Mapping):
        raise _invalid("The recording has no room performance")
    if (
        not isinstance(performance.get("roomId"), str)
        or not performance.get("roomId")
        or type(performance.get("performanceId")) is not int
        or performance["performanceId"] < 1
    ):
        raise _invalid("The room performance identity is missing")
    return performance


def read_room_timeline(path: Path, frames: int, rate: int) -> list[tuple[int, int, int]]:
    segments = []
    previous_end = 0
    previous_position = 0
    try:
        with path.open(encoding="utf-8", newline="") as stream:
            for row in csv.DictReader(stream):
                offset, position, count, actual_rate, valid, clock_rate = (
                    int(row[key])
                    for key in (
                        "wavOffsetFrames",
                        "timelineFrame",
                        "frames",
                        "sampleRateHz",
                        "roomClockValid",
                        "timelineSampleRateHz",
                    )
                )
                if (
                    offset < previous_end
                    or count <= 0
                    or offset + count > frames
                    or actual_rate != rate
                    or clock_rate != VOICE_SAMPLE_RATE_HZ
                    or position < 0
                ):
                    raise _invalid("Singer source has an invalid room timeline")
                previous_end = offset + count
                if valid == 1:
                    if position <= previous_position:
                        raise _invalid("Singer source has an invalid room position")
                    segments.append((offset, position, count))
                    previous_position = position
                elif valid != 0:
                    raise _invalid("Singer source has an invalid room clock flag")
    except (OSError, KeyError, ValueError, TypeError) as exc:
        raise _invalid("Singer source has no readable room timeline") from exc
    if not segments:
        raise _invalid("Singer source has no measured room timeline")
    return segments


def export_room_source(recording: Recording, participant_id: str) -> Path:
    performance = _performance(recording)
    if not participant_id or len(participant_id) > 128:
        raise _invalid("Singer identity is missing")
    native = recording.file_path.with_suffix(".wav")
    candidates = [
        Path(str(native) + suffix) for suffix in (".dry-incomplete.wav", ".dry.wav", ".dry.flac")
    ]
    voice = next((path for path in candidates if path.is_file()), None)
    if voice is None:
        raise _invalid("The separate microphone source is unavailable")
    voice = ensure_within(voice, recording.file_path.parent)
    timeline = ensure_within(Path(str(native) + ".timeline.csv"), recording.file_path.parent)
    info = sf.info(voice)
    read_room_timeline(timeline, info.frames, info.samplerate)
    metadata = {
        "formatVersion": 1,
        "roomId": performance["roomId"],
        "performanceId": performance["performanceId"],
        "participantId": participant_id,
        "frames": info.frames,
        "sampleRate": info.samplerate,
        "channels": info.channels,
        "voiceFormat": info.format,
    }
    target = ensure_within(
        voice.parent
        / f"room-source-{hashlib.sha256(participant_id.encode()).hexdigest()[:16]}.zip",
        recording.file_path.parent,
    )
    return _publish_room_bundle(voice, timeline, metadata, target)


def _publish_room_bundle(
    voice: Path, timeline: Path, metadata: Mapping[str, object], target: Path
) -> Path:
    if target.is_file() and target.stat().st_mtime_ns >= max(
        voice.stat().st_mtime_ns, timeline.stat().st_mtime_ns
    ):
        try:
            with zipfile.ZipFile(target) as archive:
                if loads_object(archive.read("metadata.json").decode("utf-8")) == metadata:
                    return target
        except (OSError, ValueError, KeyError, zipfile.BadZipFile):
            pass
    with TemporaryDirectory(prefix=".room-source-", dir=voice.parent) as temporary:
        prepared = Path(temporary) / "source.zip"
        with zipfile.ZipFile(
            prepared, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1
        ) as archive:
            archive.writestr("metadata.json", dumps(metadata))
            archive.write(voice, "voice.wav")
            archive.write(timeline, "timeline.csv")
        replace_with_retry(prepared, target)
    return target


def room_source_state(recording: Recording) -> dict[str, object] | None:
    path = recording.file_path.parent / "room-sources" / "manifest.json"
    if not path.is_file():
        return None
    try:
        raw = loads_object(path.read_text(encoding="utf-8"))
        if isinstance(raw, dict) and raw.get("status") in ["pending", "ready", "unavailable"]:
            return raw
    except (OSError, ValueError):
        pass
    return {"status": "unavailable", "participants": {}, "reason": "UnreadableManifest"}


def initialize_room_sources(recording: Recording) -> None:
    if not isinstance((recording.session_metadata or {}).get("roomPerformance"), Mapping):
        return
    timeline = Path(str(recording.file_path.with_suffix(".wav")) + ".timeline.csv")
    if timeline.is_file() and room_source_state(recording) is None:
        path = ensure_within(
            recording.file_path.parent / "room-sources" / "manifest.json",
            recording.file_path.parent,
        )
        atomic_write_text(path, dumps({"status": "pending", "participants": {}}))


def complete_room_sources(
    recording: Recording,
    participants: Mapping[str, list[str] | None],
    *,
    failure: str | None = None,
) -> dict[str, object]:
    performance = _performance(recording)
    root = ensure_within(recording.file_path.parent / "room-sources", recording.file_path.parent)
    if not participants and failure is None:
        raise _invalid("The performance has no singer sources")
    for participant, directories in participants.items():
        for directory in directories or []:
            _validate_imported(ensure_within(root / directory, root), performance, participant)
    state: dict[str, object] = {
        "status": "unavailable" if failure is not None else "ready",
        "participants": dict(participants),
    }
    if failure is not None:
        state["reason"] = failure
    atomic_write_text(root / "manifest.json", dumps(state))
    return state


def _source_format(
    metadata: Mapping[str, object], performance: Mapping[str, object], participant: str
) -> tuple[int, int, int]:
    expected = {
        "formatVersion": 1,
        "participantId": participant,
        "roomId": performance["roomId"],
        "performanceId": performance["performanceId"],
    }
    if any(metadata.get(key) != value for key, value in expected.items()):
        raise _invalid("The singer source belongs to another performance")
    frames, rate, channels = (
        _positive_int(metadata, key) for key in ("frames", "sampleRate", "channels")
    )
    if not 8000 <= rate <= 384000 or channels > 32 or frames > rate * 86400:
        raise _invalid("Singer source format is invalid")
    return frames, rate, channels


def _validate_imported(path: Path, performance: Mapping[str, object], participant: str) -> None:
    try:
        metadata = loads_object((path / "metadata.json").read_text(encoding="utf-8"))
        frames, rate, channels = _source_format(metadata, performance, participant)
        info = sf.info(path / "voice.wav")
        if (info.frames, info.samplerate, info.channels) != (
            frames,
            rate,
            channels,
        ) or info.format not in ["WAV", "WAVEX", "RF64", "FLAC"]:
            raise _invalid("Singer source audio differs from its metadata")
        read_room_timeline(path / "timeline.csv", frames, rate)
    except (OSError, ValueError, sf.LibsndfileError) as exc:
        raise _invalid("The imported singer source is missing or unreadable") from exc


def _validate_archive(
    archive: zipfile.ZipFile, performance: Mapping[str, object], participant: str
) -> None:
    names = archive.namelist()
    if len(names) != len(_FILES) or set(names) != set(_FILES):
        raise _invalid("Singer source archive contains unexpected files")
    if archive.getinfo("metadata.json").file_size > 65536:
        raise _invalid("Singer source metadata is too large")
    metadata = loads_object(archive.read("metadata.json").decode("utf-8"))
    frames, rate, channels = _source_format(metadata, performance, participant)
    limits = {
        "voice.wav": min(frames * channels * 8 + 65536, 8 * 1024**3),
        "timeline.csv": min(frames * 192 + 1024, 8 * 1024**3),
    }
    if any(archive.getinfo(name).file_size > limit for name, limit in limits.items()):
        raise _invalid("Singer source exceeds its declared audio length")


def room_sources_for_master(recording: Recording) -> dict[str, list[Path]] | None:
    state = room_source_state(recording)
    if state is None:
        return None
    if state.get("status") != "ready":
        raise _invalid("Separate room voices have not finished transferring")
    participants = state.get("participants")
    if not isinstance(participants, dict) or not participants:
        raise _invalid("The room singer manifest is invalid")
    performance = _performance(recording)
    root = ensure_within(recording.file_path.parent / "room-sources", recording.file_path.parent)
    sources = {}
    for participant, directories in participants.items():
        if directories is None:
            continue
        if not isinstance(directories, list) or not all(
            isinstance(directory, str) for directory in directories
        ):
            raise _invalid("The room singer manifest is invalid")
        sources[participant] = [ensure_within(root / directory, root) for directory in directories]
        for path in sources[participant]:
            _validate_imported(path, performance, participant)
    return sources


def import_room_source(recording: Recording, participant_id: str, bundle: Path) -> Path:
    performance = _performance(recording)
    root = ensure_within(recording.file_path.parent / "room-sources", recording.file_path.parent)
    root.mkdir(exist_ok=True)
    target = ensure_within(
        root / f"{hashlib.sha256(participant_id.encode()).hexdigest()[:16]}-{sha256_file(bundle)}",
        root,
    )
    try:
        with zipfile.ZipFile(bundle) as archive:
            _validate_archive(archive, performance, participant_id)
            if target.is_dir():
                _validate_imported(target, performance, participant_id)
                return target
            with TemporaryDirectory(prefix=".import-", dir=root) as temporary:
                prepared = Path(temporary) / "source"
                prepared.mkdir()
                for name in _FILES:
                    with archive.open(name) as source, (prepared / name).open("wb") as output:
                        shutil.copyfileobj(source, output, length=65536)
                _validate_imported(prepared, performance, participant_id)
                replace_with_retry(prepared, target)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, sf.LibsndfileError) as exc:
        raise _invalid("Singer source archive is unreadable") from exc
    return target
