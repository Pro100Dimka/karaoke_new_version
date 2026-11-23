from __future__ import annotations

import json
import threading
import zipfile
from dataclasses import replace
from pathlib import Path

import pytest

from backend.infrastructure.recording_archive import RecordingArchive
from backend.songs.domain import CoverState
from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.helpers import import_song, wait_for_job
from tests.test_recordings_analysis import ready_song, register_recording

pytestmark = pytest.mark.integration


def transfer(client, action: str, path: Path | None = None):
    response = client.post(
        f"/packages/library/{action}", json={"path": str(path)} if path else None
    )
    assert response.status_code == 202, response.text
    job = wait_for_job(client, response.json()["jobId"])
    assert job["state"] == "Succeeded", job
    return job["report"]


def test_library_export_ignores_recording_compression_staging(tmp_path, monkeypatch):
    monkeypatch.setattr(RecordingArchive, "_archive_one", lambda _archive, _marker: None)
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        recording = register_recording(client, ready_song(client, source))
        media = Path(recording["filePath"])
        staging = media.with_suffix(".compressing.flac")
        staging.write_bytes(b"partial recording compression")
        with zipfile.ZipFile(transfer(client, "export")["path"]) as archive:
            names = {Path(name).name for name in archive.namelist()}
        assert media.name in names
        assert staging.name not in names


def test_library_roundtrip_preserves_all_song_data_and_adds_without_replacing(tmp_path: Path):
    source_root, target_root = tmp_path / "source", tmp_path / "target"
    audio = tmp_path / "song.wav"
    write_wav(audio)
    with app_client(source_root, ai_providers=(FakeAiProvider(),)) as client:
        song = ready_song(client, audio)
        song_id = song["songId"]
        recording = register_recording(client, song)
        analysis = client.post(f"/recordings/{recording['recordingId']}/analysis")
        assert wait_for_job(client, analysis.json()["jobId"])["state"] == "Succeeded"
        cover = source_root / "songs" / song_id / "cover" / "custom.png"
        cover.parent.mkdir()
        cover.write_bytes(b"custom cover")
        with client.app.state.container.database.create() as transaction:
            original = transaction.songs.get(song_id)
            transaction.songs.update(
                replace(original, cover_path=cover, cover_state=CoverState.CUSTOM)
            )
            transaction.commit()
        unprocessed = tmp_path / "unprocessed.wav"
        write_wav(unprocessed, frequency=441)
        pending = import_song(client, unprocessed, title="Unprocessed")
        (source_root / ".env").write_text("PRIVATE_TOKEN=never-share", encoding="utf-8")
        archive = Path(transfer(client, "export")["path"])
        with zipfile.ZipFile(archive) as bundle:
            manifest = bundle.read("library.json").decode()
            assert "PRIVATE_TOKEN" not in manifest
            assert "application_settings" not in manifest
            assert not any(name.endswith((".env", "app.db")) for name in bundle.namelist())
        exported_files = {
            path.relative_to(source_root): path.read_bytes()
            for path in (source_root / "songs").rglob("*")
            if path.is_file() and path.name != "source.ref" and path.name != "manifest.json"
        }
        recorded_audio = Path(recording["filePath"]).read_bytes()

    with app_client(target_root) as client:
        other_audio = tmp_path / "other.wav"
        write_wav(other_audio, frequency=550)
        existing = import_song(client, other_audio, title="Keep my song")
        result = transfer(client, "import", archive)
        assert result == {
            "imported": 2,
            "skipped": 0,
            "recordingsAdded": 1,
            "recordingsSkipped": 0,
        }
        songs = client.get("/songs").json()["items"]
        assert {item["songId"] for item in songs} == {
            song_id,
            pending["songId"],
            existing["songId"],
        }
        assert client.get(f"/songs/{existing['songId']}").json()["title"] == "Keep my song"
        saved = client.get(f"/songs/{song_id}").json()
        assert saved["status"] == "Ready"
        for relative, data in exported_files.items():
            assert (target_root / relative).read_bytes() == data
        with client.app.state.container.database.create() as transaction:
            restored = transaction.songs.get(song_id)
            assert restored.source_path.is_relative_to(target_root)
            assert restored.source_path.read_bytes() == audio.read_bytes()
            assert restored.cover_path.read_bytes() == b"custom cover"
            assert transaction.projects.get(song_id, 1) is not None
            reference = target_root / "songs" / song_id / "revisions" / "1" / "source.ref"
            assert reference.read_text(encoding="utf-8") == str(restored.source_path)
            assert transaction.projects.get(song_id, song["activeRevision"]) is not None
            take = transaction.recordings.get(recording["recordingId"])
            assert take.file_path.is_relative_to(target_root)
            assert take.file_path.read_bytes() == recorded_audio
            assert (
                transaction.analyses.list_for_recording(take.recording_id)[0].state.value
                == "Succeeded"
            )
        assert transfer(client, "import", archive) == {
            "imported": 0,
            "skipped": 2,
            "recordingsAdded": 0,
            "recordingsSkipped": 1,
        }
        assert len(client.get("/songs").json()["items"]) == 3
        assert client.get("/recordings").json()["total"] == 1


def test_library_export_snapshots_a_clip_before_manual_replacement(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    original_clip = tmp_path / "original.mp4"
    original_clip.write_bytes(b"\x00\x00\x00\x18ftyporiginal-video")
    replacement = tmp_path / "replacement.mp4"
    replacement.write_bytes(b"\x00\x00\x00\x18ftypreplacement-video")
    with app_client(tmp_path / "source-runtime", ai_providers=(FakeAiProvider(),)) as client:
        song = import_song(client, source)
        selected = client.patch(f"/songs/{song['songId']}", json={"videoPath": str(original_clip)})
        assert selected.status_code == 200, selected.text
        package = _export_while_replacing_clip(client, song["songId"], replacement, monkeypatch)
        assert client.get(f"/songs/{song['songId']}/clip").content == replacement.read_bytes()
        assert client.get(f"/songs/{song['songId']}").json()["title"] == "Changed during export"
        assert not tuple(client.app.state.container.roots.temp.glob("library-*"))

    with app_client(tmp_path / "target-runtime", ai_providers=(FakeAiProvider(),)) as client:
        assert transfer(client, "import", package) == {
            "imported": 1,
            "skipped": 0,
            "recordingsAdded": 0,
            "recordingsSkipped": 0,
        }
        assert client.get(f"/songs/{song['songId']}/clip").content == original_clip.read_bytes()
        assert client.get(f"/songs/{song['songId']}").json()["title"] == song["title"]


def _export_while_replacing_clip(client, song_id, replacement, monkeypatch):
    archive = client.app.state.container.packages.library._archive
    build = archive.build
    entered, release = threading.Event(), threading.Event()

    def blocked_build(*args, **kwargs):
        entered.set()
        assert release.wait(10), "Manual clip replacement did not finish"
        return build(*args, **kwargs)

    monkeypatch.setattr(archive, "build", blocked_build)
    started = client.post("/packages/library/export")
    assert started.status_code == 202, started.text
    try:
        assert entered.wait(10), "Library export did not reach archive construction"
        changed = client.patch(
            f"/songs/{song_id}",
            json={"videoPath": str(replacement), "title": "Changed during export"},
        )
        assert changed.status_code == 200, changed.text
    finally:
        release.set()
    exported = wait_for_job(client, started.json()["jobId"])
    assert exported["state"] == "Succeeded", exported
    return Path(exported["report"]["path"])


@pytest.mark.parametrize("damage", ["traversal", "checksum", "invalid_manifest"])
def test_invalid_library_never_publishes_partial_songs(tmp_path: Path, damage: str):
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "source") as client:
        import_song(client, source)
        good = Path(transfer(client, "export")["path"])
    broken = tmp_path / "broken.zip"
    with zipfile.ZipFile(good) as original, zipfile.ZipFile(broken, "w") as output:
        for name in original.namelist():
            data = original.read(name)
            if damage == "checksum" and name.endswith(".wav"):
                data = b"changed source"
            if damage == "invalid_manifest" and name == "library.json":
                data = json.dumps({"version": 999}).encode()
            output.writestr(name, data)
        if damage == "traversal":
            output.writestr("../outside.wav", b"unsafe")
    target = tmp_path / "target"
    with app_client(target) as client:
        started = client.post("/packages/library/import", json={"path": str(broken)})
        assert started.status_code == 202, started.text
        job = wait_for_job(client, started.json()["jobId"])
        assert job["state"] == "Failed", job
        assert client.get("/songs").json()["items"] == []
        assert not list((target / "songs").iterdir())
    assert not (tmp_path / "outside.wav").exists()


def test_empty_library_can_be_exported_and_imported(tmp_path: Path):
    with app_client(tmp_path / "source") as client:
        archive = Path(transfer(client, "export")["path"])
    with app_client(tmp_path / "target") as client:
        assert transfer(client, "import", archive) == {
            "imported": 0,
            "skipped": 0,
            "recordingsAdded": 0,
            "recordingsSkipped": 0,
        }


def test_library_publication_failure_rolls_back_files_and_rows(tmp_path: Path, monkeypatch):
    from backend.infrastructure import library_storage

    with app_client(tmp_path / "source") as client:
        for frequency in (440, 550):
            audio = tmp_path / f"{frequency}.wav"
            write_wav(audio, frequency=frequency)
            import_song(client, audio)
        archive = Path(transfer(client, "export")["path"])
    root = tmp_path / "target"
    publish = library_storage.os.replace
    calls = 0

    def interrupted(source, target):
        nonlocal calls
        if Path(target).parent == root / "songs":
            calls += 1
            if calls == 2:
                raise OSError("Simulated storage failure")
        publish(source, target)

    monkeypatch.setattr(library_storage.os, "replace", interrupted)
    with app_client(root) as client:
        started = client.post("/packages/library/import", json={"path": str(archive)})
        assert wait_for_job(client, started.json()["jobId"])["state"] == "Failed"
        assert calls == 2
        assert client.get("/songs").json()["items"] == []
        assert not list((root / "songs").iterdir())
