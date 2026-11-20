from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest

from backend.analysis.domain import AnalysisResult, AnalysisState
from backend.infrastructure.hashing import sha256_file
from backend.infrastructure.recording_archive import RecordingArchive
from backend.lyrics.codec import encode_document
from backend.lyrics.domain import LyricsDocument
from backend.projects.domain import (
    ArtifactCategory,
    ProjectArtifact,
    ProjectManifest,
    ProjectRevision,
)
from backend.projects.fingerprint import manifest_fingerprint
from backend.projects.manifest_codec import decode_manifest, encode_manifest
from backend.songs.domain import SongStatus
from backend.version import ANALYSIS_ALGORITHM_VERSION
from tests.conftest import app_client, write_wav
from tests.helpers import import_song, wait_for_job
from tests.test_library_archive import transfer

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def controlled_archive(monkeypatch):
    monkeypatch.setattr(RecordingArchive, "_step", lambda self: self._cancel.wait(0.05))


def _reference(client, song_id, revision):
    container = client.app.state.container
    root = container.roots.songs / song_id / "revisions"
    imported = decode_manifest((root / "1/manifest.json").read_text())
    with container.database.create() as transaction:
        song = transaction.songs.get(song_id)
        lineage = transaction.projects.get(song_id, 1).lineage_id
    files = {
        "source.ref": song.source_path.as_posix().encode(),
        "audio/instrumental.wav": song.source_path.read_bytes(),
        "audio/reference-vocal.wav": song.source_path.read_bytes(),
        "lyricsSync.json": encode_document(
            LyricsDocument("Tiny fixture", "", 0.1, 100 + revision, None, "", ())
        ).encode(),
    }
    files["lyricsBaseline.json"] = files["lyricsSync.json"]
    target = root / str(revision)
    for name, data in files.items():
        path = target / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    artifacts = [replace(imported.artifacts[0], checksum=sha256_file(target / "source.ref"))]
    for name, path in (
        ("instrumental", "audio/instrumental.wav"),
        ("referenceVocal", "audio/reference-vocal.wav"),
        ("lyricsSync", "lyricsSync.json"),
        ("lyricsBaseline", "lyricsBaseline.json"),
    ):
        artifacts.append(
            ProjectArtifact(name, Path(path), ArtifactCategory.PORTABLE, sha256_file(target / path))
        )
    manifest = ProjectManifest(imported.project_format_version, song_id, revision, artifacts, {})
    (target / "manifest.json").write_text(encode_manifest(manifest))
    with container.database.create() as transaction:
        transaction.projects.add(
            ProjectRevision(
                song_id,
                revision,
                manifest_fingerprint(manifest),
                manifest.project_format_version,
                lineage,
                datetime.now(UTC),
            )
        )
        transaction.songs.update(replace(song, active_revision=revision, status=SongStatus.READY))
        transaction.commit()
    return client.get(f"/songs/{song_id}").json()


def _take(client, song, source_id=None):
    target = client.post("/recordings/target").json()
    path = Path(target["filePath"])
    write_wav(path, seconds=0.1)
    metadata = {"studioMaster": {"sourceRecordingId": source_id}} if source_id else {}
    response = client.post(
        "/recordings",
        json={
            **target,
            "duration": 0.1,
            "sampleRate": 16000,
            "channels": 1,
            "createdAt": datetime.now(UTC).isoformat(),
            "songId": song["songId"],
            "songRevision": song["activeRevision"],
            "sessionMetadata": metadata,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def _snapshots(
    tmp_path,
    *,
    extra=1,
    master=False,
    orphan=False,
    newer=False,
    cycle=False,
    existing_source=False,
    analysis_newer=False,
):
    source = tmp_path / "tone.wav"
    write_wav(source, seconds=0.1)
    with app_client(tmp_path / "source") as client:
        imported = import_song(client, source)
        song = _reference(client, imported["songId"], 2)
        first = _take(client, song)
        early = Path(transfer(client, "export")["path"])
        if newer:
            song = _reference(client, song["songId"], 3)
        takes = [_take(client, song)]
        if extra == 2 or master:
            original = first if existing_source else takes[0]
            takes.append(_take(client, song, original["recordingId"] if master else None))
        if orphan:
            assert client.delete(f"/recordings/{takes[0]['recordingId']}").status_code == 204
            takes = takes[1:]
        if cycle:
            with client.app.state.container.database.create() as transaction:
                original = transaction.recordings.get(takes[0]["recordingId"])
                transaction.recordings.update(
                    replace(
                        original,
                        session_metadata={
                            "studioMaster": {"sourceRecordingId": takes[-1]["recordingId"]},
                        },
                    ),
                    frozenset({"session_metadata"}),
                )
                transaction.commit()
        if analysis_newer:
            song = _reference(client, song["songId"], 3)
        now = datetime.now(UTC)
        result = AnalysisResult(
            str(uuid4()),
            takes[-1]["recordingId"],
            song["songId"],
            song["activeRevision"],
            ANALYSIS_ALGORITHM_VERSION,
            AnalysisState.SUCCEEDED,
            now,
            now,
            sha256_file(Path(takes[-1]["filePath"])),
        )
        with client.app.state.container.database.create() as transaction:
            transaction.analyses.add(result)
            transaction.commit()
        late = Path(transfer(client, "export")["path"])
    return SimpleNamespace(song=song, first=first, takes=takes, early=early, late=late)


def _files(root):
    return {
        str(path.relative_to(root)): sha256_file(path)
        for folder in ("songs", "recordings")
        for path in (root / folder).rglob("*")
        if path.is_file()
    }


def _import_job(client, path):
    response = client.post("/packages/library/import", json={"path": str(path)})
    assert response.status_code == 202, response.text
    return wait_for_job(client, response.json()["jobId"])


def test_newer_backup_adds_only_missing_takes_and_is_idempotent(tmp_path, monkeypatch):
    from backend.infrastructure import library_selection

    saved = _snapshots(tmp_path, extra=2)
    root = tmp_path / "target"
    with app_client(root) as client:
        transfer(client, "import", saved.early)
        renamed = client.patch(
            f"/recordings/{saved.first['recordingId']}", json={"displayName": "Keep local name"}
        ).json()
        existing_song = client.get(f"/songs/{saved.song['songId']}").json()
        before = _files(root)
        hashed = []

        def fingerprint(path):
            hashed.append(path)
            return sha256_file(path)

        monkeypatch.setattr(library_selection, "sha256_file", fingerprint)
        report = transfer(client, "import", saved.late)
        assert report == {"imported": 0, "skipped": 1, "recordingsAdded": 2, "recordingsSkipped": 1}
        assert len(hashed) == len(set(hashed)) == 8  # Four portable files, once in each library.
        assert client.get("/recordings").json()["total"] == 3
        assert client.get(f"/recordings/{saved.first['recordingId']}").json() == renamed
        assert client.get(f"/songs/{saved.song['songId']}").json() == existing_song
        assert all(_files(root)[path] == checksum for path, checksum in before.items())
        take = saved.takes[-1]
        assert (
            client.get(f"/recordings/{take['recordingId']}/analyses").json()[0]["state"]
            == "Succeeded"
        )
        after = _files(root)
        assert transfer(client, "import", saved.late) == {
            "imported": 0,
            "skipped": 1,
            "recordingsAdded": 0,
            "recordingsSkipped": 3,
        }
        assert len(hashed) == 8
        assert _files(root) == after


@pytest.mark.parametrize("damage", ["missing-reference", "different-reference", "missing-audio"])
def test_conflicting_reference_fails_before_any_recording_is_published(tmp_path, damage):
    saved = _snapshots(tmp_path, newer=damage == "missing-reference")
    root = tmp_path / "target"
    with app_client(root) as client:
        transfer(client, "import", saved.early)
        revision = root / "songs" / saved.song["songId"] / "revisions/2"
        if damage == "different-reference":
            lyrics = revision / "lyricsSync.json"
            lyrics.write_text(encode_document(LyricsDocument("Other", "", 0.1, 44, None, "", ())))
            manifest = decode_manifest((revision / "manifest.json").read_text())
            manifest = replace(
                manifest,
                artifacts=tuple(
                    replace(item, checksum=sha256_file(lyrics))
                    if item.logical_name == "lyricsSync"
                    else item
                    for item in manifest.artifacts
                ),
            )
            (revision / "manifest.json").write_text(encode_manifest(manifest))
        elif damage == "missing-audio":
            (revision / "audio/reference-vocal.wav").unlink()
        before = _files(root)
        job = _import_job(client, saved.late)
        assert job["state"] == "Failed", job
        assert job["error"]["code"] == "LibraryRecordingConflict"
        assert job["error"]["details"]["recordingId"] == saved.takes[0]["recordingId"]
        assert "reference" in job["error"]["message"].lower()
        assert _files(root) == before
        assert client.get("/recordings").json()["total"] == 1


@pytest.mark.parametrize("relation", ["new-original", "existing-original", "retained-orphan"])
def test_append_preserves_master_links_and_intentional_retained_orphans(tmp_path, relation):
    saved = _snapshots(
        tmp_path,
        master=True,
        orphan=relation == "retained-orphan",
        existing_source=relation == "existing-original",
    )
    with app_client(tmp_path / "target") as client:
        transfer(client, "import", saved.early)
        report = transfer(client, "import", saved.late)
        assert report["recordingsAdded"] == len(saved.takes)
        for take in saved.takes:
            restored = client.get(f"/recordings/{take['recordingId']}").json()
            assert restored["sourceRecordingId"] == take["sourceRecordingId"]
            assert Path(restored["filePath"]).is_file()
        master = saved.takes[-1]
        assert (
            client.get(f"/recordings/{master['recordingId']}/analyses").json()[0]["state"]
            == "Succeeded"
        )


def test_analysis_reference_must_also_exist_before_its_take_is_added(tmp_path):
    saved = _snapshots(tmp_path, analysis_newer=True)
    root = tmp_path / "target"
    with app_client(root) as client:
        transfer(client, "import", saved.early)
        before = _files(root)
        job = _import_job(client, saved.late)
        assert job["state"] == "Failed", job
        assert job["error"]["code"] == "LibraryRecordingConflict"
        assert job["error"]["details"] == {
            "recordingId": saved.takes[0]["recordingId"],
            "reason": "ReferenceMissing",
        }
        assert client.get("/recordings").json()["total"] == 1
        assert _files(root) == before


@pytest.mark.parametrize("master", [False, True])
def test_self_or_cyclic_master_links_are_rejected_atomically(tmp_path, master):
    saved = _snapshots(tmp_path, master=master, cycle=True)
    root = tmp_path / "target"
    with app_client(root) as client:
        transfer(client, "import", saved.early)
        before = _files(root)
        job = _import_job(client, saved.late)
        assert job["state"] == "Failed", job
        assert job["error"]["code"] == "LibraryRecordingConflict"
        assert job["error"]["details"]["reason"] == "SourceCycle"
        assert _files(root) == before


def test_deleted_take_restores_with_its_existing_history_without_duplicates(tmp_path):
    saved = _snapshots(tmp_path)
    with app_client(tmp_path / "target") as client:
        transfer(client, "import", saved.early)
        history = client.get("/history").json()
        assert client.delete(f"/recordings/{saved.first['recordingId']}").status_code == 204
        assert transfer(client, "import", saved.early)["recordingsAdded"] == 1
        assert client.get(f"/recordings/{saved.first['recordingId']}").status_code == 200
        assert client.get("/history").json() == history


def test_append_publication_failure_rolls_back_only_new_recording_directories(
    tmp_path, monkeypatch
):
    from backend.infrastructure import library_storage

    saved = _snapshots(tmp_path, extra=2)
    root = tmp_path / "target"
    with app_client(root) as client:
        transfer(client, "import", saved.early)
        before = _files(root)
        rename = library_storage.os.replace
        attempts = []

        def interrupted(source, target):
            if Path(target).parent == root / "recordings":
                attempts.append(target)
                if len(attempts) == 2:
                    raise OSError("Injected publication failure")
            return rename(source, target)

        monkeypatch.setattr(library_storage.os, "replace", interrupted)
        job = _import_job(client, saved.late)
        assert len(attempts) == 2
        assert job["state"] == "Failed"
        assert client.get("/recordings").json()["total"] == 1
        assert _files(root) == before
