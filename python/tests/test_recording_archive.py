from __future__ import annotations

from contextlib import contextmanager
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
import threading

import pytest
import soundfile as sf

from backend.domain_errors import ConflictError
from backend.infrastructure import recording_archive as archive_module
from backend.infrastructure.process_runner import ProcessRunner
from backend.infrastructure.recording_archive import RecordingArchive
from backend.infrastructure.wave_recording import WaveRecordingInspector
from backend.recordings.domain import Recording
from backend.recordings.lifecycle import RecordingLifecycle
from backend.recordings.register_recording import RegisterRecording, RegisterRecordingRequest


class _Recordings:
    def __init__(self, records):
        self.records = records

    def get(self, recording_id):
        return self.records.get(recording_id)

    def add(self, recording):
        self.records[recording.recording_id] = recording

    def update(self, recording, fields):
        current = self.records[recording.recording_id]
        updated = replace(current, **{name: getattr(recording, name) for name in fields})
        self.records[recording.recording_id] = updated
        return updated

    def update_file(self, recording_id, path, metadata):
        self.records[recording_id] = replace(
            self.records[recording_id],
            file_path=path,
            duration=metadata.duration,
            sample_rate=metadata.sample_rate,
            channels=metadata.channels,
        )

    def list(self, *, song_id, limit, offset):
        values = [
            item for item in self.records.values() if song_id is None or item.song_id == song_id
        ]
        return values[offset : offset + limit]

    def count(self, *, song_id):
        return len(self.list(song_id=song_id, limit=len(self.records), offset=0))


class _Database:
    def __init__(self, *recordings):
        self.records = {item.recording_id: item for item in recordings}
        self.history = []
        self.commits = 0

    @contextmanager
    def create(self):
        recordings = _Recordings(dict(self.records))
        history = []

        def commit():
            self.records = recordings.records
            self.history.extend(history)
            self.commits += 1

        yield SimpleNamespace(
            recordings=recordings,
            history=SimpleNamespace(add=history.append),
            commit=commit,
        )


def _recording(root, recording_id="take", *, master=False, status="Ready"):
    source = root / recording_id / "recording.wav"
    source.parent.mkdir(parents=True)
    sf.write(source, [0.05, -0.05] * 2048, 48000, subtype="PCM_16")
    session = {"capture": "kept"}
    if master:
        session["studioMaster"] = {"sourceRecordingId": "deleted-original", "balance": {"gain": 1}}
    return Recording(
        recording_id,
        source,
        4096 / 48000,
        48000,
        1,
        datetime.now(UTC),
        gaps=({"start": 0.01, "duration": 0.005},),
        session_metadata=session,
        display_name="Saved take",
        file_status=status,
    )


def _unavailable_analysis(_recording_id):
    raise AssertionError("Archival must not depend on analysis results")


@pytest.fixture
def archive_factory(tmp_path, monkeypatch):
    calls = []

    def encode(source, _runner, _cancel, *, master):
        calls.append((source, master))
        target = source.with_suffix(".flac")
        if target != source:
            samples, rate = sf.read(source)
            sf.write(target, samples, rate, subtype="PCM_16")
        return target

    monkeypatch.setattr(archive_module, "compact_recording", encode, raising=False)
    monkeypatch.setattr(archive_module, "prepare_dry_archive", lambda *_: None, raising=False)
    monkeypatch.setattr(archive_module, "retire_dry_archive", lambda _: None, raising=False)

    def create(database, *, when_idle=lambda action: action()):
        archive = RecordingArchive(tmp_path, database, ProcessRunner(), when_idle)
        archive._analyses = _unavailable_analysis
        return archive

    return SimpleNamespace(create=create, calls=calls)


@pytest.mark.parametrize("master", [False, True], ids=["original-without-master", "orphan-master"])
def test_ready_recordings_archive_independently_without_analysis(
    tmp_path,
    archive_factory,
    master,
):
    original = _recording(tmp_path, master=master)
    database = _Database(original)
    archive = archive_factory.create(database)
    archive.request(original.recording_id)
    marker = original.file_path.parent / "archive-pending.json"
    assert marker.is_file()
    assert archive_factory.calls == [], "Registration must only queue background work"
    archive._archive_one(marker)
    saved = database.records[original.recording_id]
    assert saved.file_path.suffix == ".flac"
    assert replace(saved, file_path=original.file_path) == original
    assert archive_factory.calls == [(original.file_path, master)]
    assert not original.file_path.exists()
    assert not marker.exists()
    assert (saved.file_path.parent / "archive-complete.json").is_file()
    assert database.history == []


@pytest.mark.parametrize("status", ["Preparing", "PreparationFailed", "RecoveredIncomplete"])
def test_unfinished_and_unregistered_native_captures_are_not_archived(
    tmp_path,
    archive_factory,
    status,
):
    original = _recording(tmp_path, status=status)
    unregistered = _recording(tmp_path, "native-capture")
    before = {item.file_path: item.file_path.read_bytes() for item in (original, unregistered)}
    archive = archive_factory.create(_Database(original))
    archive.request(original.recording_id)
    archive._wake.set()
    archive._step()
    assert archive_factory.calls == []
    assert not list(tmp_path.glob("*/archive-pending.json"))
    assert {path: path.read_bytes() for path in before} == before


def test_background_backfill_resumes_pending_and_skips_completed_unchanged_fallback(
    tmp_path,
    archive_factory,
):
    first = _recording(tmp_path, "first")
    second = _recording(tmp_path, "second")
    database = _Database(first, second)
    marker = second.file_path.parent / "archive-pending.json"
    marker.write_text('{"recordingId":"second"}')
    archive = archive_factory.create(database)
    assert archive_factory.calls == []
    archive._wake.set()
    archive._step()
    assert {path for path, _ in archive_factory.calls} == {first.file_path, second.file_path}
    restarted = archive_factory.create(database)
    restarted._wake.set()
    restarted._step()
    assert len(archive_factory.calls) == 2
    assert not list(tmp_path.glob("*/archive-pending.json"))
    changed = database.records["first"].file_path
    sf.write(changed, [0.1, -0.1] * 2048, 48000, subtype="PCM_16")
    restarted = archive_factory.create(database)
    restarted._wake.set()
    restarted._step()
    assert archive_factory.calls[-1] == (changed, False)
    assert len(archive_factory.calls) == 3


def test_busy_jobs_defer_encoding_and_publication(tmp_path, archive_factory):
    original = _recording(tmp_path)
    database = _Database(original)

    def busy(_action):
        raise ConflictError("Busy", "A processing job owns these files")

    archive = archive_factory.create(database, when_idle=busy)
    archive.request(original.recording_id)
    marker = original.file_path.parent / "archive-pending.json"
    assert marker.is_file()
    archive._archive_one(marker)
    assert archive_factory.calls == []
    assert database.records[original.recording_id] == original
    assert original.file_path.is_file() and marker.is_file()


def test_windows_cleanup_denial_retries_after_restart_without_reencoding(
    tmp_path,
    archive_factory,
    monkeypatch,
):
    original = _recording(tmp_path)
    database = _Database(original)
    archive = archive_factory.create(database)
    archive.request(original.recording_id)
    marker = original.file_path.parent / "archive-pending.json"
    assert marker.is_file()
    unlink = Path.unlink
    blocked = True

    def deny_open_capture(path, *args, **kwargs):
        if path == original.file_path and blocked:
            raise PermissionError("Windows preview still owns the WAV")
        return unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", deny_open_capture)
    archive._archive_one(marker)
    assert database.records[original.recording_id].file_path.suffix == ".flac"
    assert original.file_path.exists() and marker.exists()
    assert not marker.with_name("archive-invalid.json").exists()
    blocked = False
    restarted = archive_factory.create(database)
    restarted._wake.set()
    restarted._step()
    assert not original.file_path.exists() and not marker.exists()
    assert len(archive_factory.calls) == 1


def test_cleanup_keeps_stems_and_removes_only_superseded_mix_sidecars(
    tmp_path,
    archive_factory,
):
    original = _recording(tmp_path)
    companions = [
        Path(str(original.file_path) + suffix)
        for suffix in (
            ".vocal.wav",
            ".backing.wav",
            ".dry-incomplete.wav",
            ".timeline.csv",
        )
    ]
    companions.append(original.file_path.with_name("recording.original.wav"))
    for path in companions:
        path.write_bytes(b"retained native source")
    obsolete = [
        Path(str(original.file_path) + suffix) for suffix in (".peaks.json", ".archive.json")
    ]
    for path in obsolete:
        path.write_text("obsolete")
    archive = archive_factory.create(_Database(original))
    archive.request(original.recording_id)
    marker = original.file_path.parent / "archive-pending.json"
    assert marker.is_file()
    archive._archive_one(marker)
    assert all(path.read_bytes() == b"retained native source" for path in companions)
    assert all(not path.exists() for path in obsolete)


def test_dry_source_retires_only_after_commit_under_idle_guard_and_retries_denial(
    tmp_path,
    archive_factory,
    monkeypatch,
):
    original = _recording(tmp_path)
    database = _Database(original)
    dry = Path(str(original.file_path) + ".dry.wav")
    target = dry.with_suffix(".flac")
    dry.write_bytes(b"exact dry source")
    target.write_bytes(b"verified compact dry source")
    prepared = SimpleNamespace(source=dry, target=target)
    guarded = False
    blocked = True
    retired = []

    def idle(action):
        nonlocal guarded
        guarded = True
        try:
            action()
        finally:
            guarded = False

    def retire(value):
        assert value is prepared and guarded
        assert database.records[original.recording_id].file_path.suffix == ".flac"
        if blocked:
            raise PermissionError("An external reader still owns the dry source")
        value.source.unlink()
        retired.append(value)

    monkeypatch.setattr(archive_module, "prepare_dry_archive", lambda *_: prepared)
    monkeypatch.setattr(archive_module, "retire_dry_archive", retire)
    archive = archive_factory.create(database, when_idle=idle)
    archive.request(original.recording_id)
    marker = original.file_path.parent / "archive-pending.json"
    archive._archive_one(marker)
    assert dry.is_file() and marker.is_file() and not retired
    assert not marker.with_name("archive-invalid.json").exists()
    blocked = False
    restarted = archive_factory.create(database, when_idle=idle)
    restarted._wake.set()
    restarted._step()
    assert retired == [prepared]
    assert target.is_file() and not dry.exists() and not marker.exists()
    assert len(archive_factory.calls) == 1


def test_database_publication_failure_retains_previous_audio_and_pending_retry(
    tmp_path,
    archive_factory,
    monkeypatch,
):
    original = _recording(tmp_path)
    database = _Database(original)
    create = database.create

    def fail_commit():
        raise OSError("The database is temporarily unwritable")

    @contextmanager
    def failing_transaction():
        with create() as transaction:
            transaction.commit = fail_commit
            yield transaction

    monkeypatch.setattr(database, "create", failing_transaction)
    archive = archive_factory.create(database)
    archive.request(original.recording_id)
    marker = original.file_path.parent / "archive-pending.json"
    archive._archive_one(marker)
    assert database.records[original.recording_id] == original
    assert original.file_path.is_file() and marker.is_file()
    assert not marker.with_name("archive-complete.json").exists()
    assert not marker.with_name("archive-invalid.json").exists()


def _registration(database, source, **kwargs):
    storage = SimpleNamespace(
        validate_owned_file=lambda path, **_: path,
        write_recovery_descriptor=lambda _: None,
        remove_recovery_descriptor=lambda _: None,
    )
    register = RegisterRecording(
        database,
        storage,
        WaveRecordingInspector(),
        SimpleNamespace(now=lambda: datetime.now(UTC)),
        SimpleNamespace(new=lambda: "history"),
        RecordingLifecycle(),
        **kwargs,
    )
    request = RegisterRecordingRequest(
        source.recording_id,
        source.file_path,
        source.duration,
        source.sample_rate,
        source.channels,
        source.created_at,
    )
    return register, request


def test_registration_notifies_only_after_ready_audio_and_database_commit(tmp_path):
    source = _recording(tmp_path)
    database = _Database()
    observed = []

    def ready(recording_id):
        observed.append((database.commits, database.records[recording_id].file_status))

    register, request = _registration(database, source, on_ready=ready)
    saved = register.execute(request)
    assert saved.file_path == source.file_path
    assert observed == [(1, "Ready")]


def test_ready_callback_failure_does_not_fail_registered_capture(tmp_path):
    source = _recording(tmp_path)
    database = _Database()

    def fail(_recording_id):
        raise OSError("The archive marker cannot be written yet")

    register, request = _registration(database, source, on_ready=fail)
    assert register.execute(request).file_status == "Ready"
    assert database.records[source.recording_id].file_path.is_file()


def test_preparation_completion_notifies_ready_callback_wired_after_construction(tmp_path):
    source = _recording(tmp_path, status="Preparing")
    database = _Database(source)
    observed = []
    register, _ = _registration(database, source)
    register.set_ready_callback(
        lambda recording_id: observed.append(database.records[recording_id])
    )
    context = SimpleNamespace(cancel=threading.Event(), ensure_not_cancelled=lambda: None)
    register._prepare(source, context)
    assert len(observed) == 1 and observed[0].file_status == "Ready"
