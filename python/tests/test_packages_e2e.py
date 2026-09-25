from __future__ import annotations

import pytest
import json
import shutil
import sqlite3
import zipfile
from pathlib import Path

from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.helpers import import_song, wait_for_job
from backend.songs.recognition import RecognizedSong
from backend.domain_errors import ConflictError
from backend.projects.operations import SongOperation, SongOperationRegistry


pytestmark = [pytest.mark.integration, pytest.mark.e2e]


class RichRecognitionProvider:
    def recognize(self, source: Path) -> RecognizedSong:
        del source
        return RecognizedSong(
            title="Detected title",
            artist="Detected artist",
            album="Detected album",
            genre="Alternative",
            artwork_url="https://images.example/cover.jpg",
            video_url="https://videos.example/clip.mp4",
            provider="test-fingerprint",
            external_id="track-123",
        )


def make_ready_and_export(client, source: Path) -> tuple[dict[str, object], Path]:
    song = import_song(client, source)
    processing = client.post(
        f"/songs/{song['songId']}/processing",
        json={"mode": "Fast", "onlineLyrics": False},
    )
    job = wait_for_job(client, processing.json()["jobId"])
    assert job["state"] == "Succeeded", job
    export = client.post(f"/packages/export/{song['songId']}")
    assert export.status_code == 202, export.text
    export_job = wait_for_job(client, export.json()["jobId"])
    assert export_job["state"] == "Succeeded", export_job
    return song, Path(export_job["report"]["path"])


def test_export_inspect_and_import_same_revision_are_idempotent(tmp_path: Path) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song, package = make_ready_and_export(client, source)
        inspected = client.post("/packages/inspect", json={"path": str(package)})
        assert inspected.status_code == 200, inspected.text
        assert inspected.json()["conflict"] == "SameRevision"

        started = client.post(
            "/packages/import",
            json={"path": str(package), "decision": "SafeOnly"},
            headers={"Idempotency-Key": "package-same"},
        )
        result = wait_for_job(client, started.json()["jobId"])
        assert result["state"] == "Succeeded", result
        assert result["report"]["songId"] == song["songId"]


def test_same_revision_import_restores_missing_project_files(tmp_path: Path) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    root = tmp_path / "runtime"
    with app_client(root, ai_providers=(FakeAiProvider(),)) as client:
        song, package = make_ready_and_export(client, source)
        revision = client.get(f"/songs/{song['songId']}").json()["activeRevision"]
        project = root / "songs" / song["songId"] / "revisions" / str(revision)
        shutil.rmtree(project)

        started = client.post(
            "/packages/import",
            json={"path": str(package), "decision": "SafeOnly"},
        )
        job = wait_for_job(client, started.json()["jobId"])
        assert job["state"] == "Succeeded", job
        assert project.joinpath("manifest.json").is_file()
        compatibility = client.get(
            f"/songs/{song['songId']}/project/compatibility?revision={revision}"
        )
        assert compatibility.json()["compatibility"] == "Current"


def test_same_revision_import_obeys_the_song_mutation_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "locked.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song, package = make_ready_and_export(client, source)
        original_claim = SongOperationRegistry._claim

        def claim(self: SongOperationRegistry, song_id: str, operation: SongOperation) -> None:
            if song_id == song["songId"] and operation is SongOperation.PACKAGE_IMPORT:
                raise ConflictError("SongOperationConflict", "Editor save owns the song")
            original_claim(self, song_id, operation)

        monkeypatch.setattr(SongOperationRegistry, "_claim", claim)
        started = client.post("/packages/import", json={"path": str(package)})
        job = wait_for_job(client, started.json()["jobId"])
        assert job["state"] == "Failed"
        assert job["error"]["code"] == "SongOperationConflict"


def test_importing_an_existing_revision_reactivates_that_valid_project(tmp_path: Path) -> None:
    source = tmp_path / "reactivate.wav"
    write_wav(source)
    root = tmp_path / "runtime"
    with app_client(root, ai_providers=(FakeAiProvider(),)) as client:
        song, _ = make_ready_and_export(client, source)
        editor = client.get(f"/songs/{song['songId']}/editor").json()
        saved = client.put(
            f"/songs/{song['songId']}/editor",
            json={"expectedRevision": editor["revision"], "document": editor["document"]},
        ).json()
        exported = client.post(f"/packages/export/{song['songId']}")
        export_job = wait_for_job(client, exported.json()["jobId"])
        package = Path(export_job["report"]["path"])
        client.put(
            f"/songs/{song['songId']}/editor",
            json={"expectedRevision": saved["revision"], "document": editor["document"]},
        )

        started = client.post(
            "/packages/import",
            json={"path": str(package), "decision": "SafeOnly"},
        )
        job = wait_for_job(client, started.json()["jobId"])
        assert job["state"] == "Succeeded", job
        assert client.get(f"/songs/{song['songId']}").json()["activeRevision"] == saved["revision"]

    with app_client(root, ai_providers=(FakeAiProvider(),)) as restarted_client:
        restored = restarted_client.get(f"/songs/{song['songId']}").json()
        assert restored["status"] == "Ready"
        assert restored["activeRevision"] == saved["revision"]


def test_exported_package_imports_into_clean_library(tmp_path: Path) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "source-runtime", ai_providers=(FakeAiProvider(),)) as source_client:
        song, package = make_ready_and_export(source_client, source)

    with app_client(tmp_path / "target-runtime") as target_client:
        inspected = target_client.post("/packages/inspect", json={"path": str(package)})
        assert inspected.status_code == 200, inspected.text
        assert inspected.json()["conflict"] == "None"
        started = target_client.post(
            "/packages/import",
            json={"path": str(package), "decision": "SafeOnly"},
        )
        job = wait_for_job(target_client, started.json()["jobId"])
        assert job["state"] == "Succeeded", job
        imported = target_client.get(f"/songs/{song['songId']}")
        assert imported.status_code == 200, imported.text
        assert imported.json()["status"] == "Ready"


def test_exported_room_project_keeps_the_downloaded_song_clip(tmp_path: Path) -> None:
    source = tmp_path / "song-with-clip.wav"
    write_wav(source)
    source_root = tmp_path / "source-runtime"
    clip_bytes = b"room-video-clip"
    with app_client(source_root, ai_providers=(FakeAiProvider(),)) as source_client:
        song, _ = make_ready_and_export(source_client, source)
        clip = source_root / "songs" / song["songId"] / "media" / "clip.mp4"
        clip.parent.mkdir(parents=True, exist_ok=True)
        clip.write_bytes(clip_bytes)
        with sqlite3.connect(source_root / "app.db") as database:
            database.execute(
                "UPDATE songs SET video_url = ? WHERE song_id = ?",
                ("local:clip", song["songId"]),
            )
        exported = source_client.post(f"/packages/export/{song['songId']}")
        export_job = wait_for_job(source_client, exported.json()["jobId"])
        package = Path(export_job["report"]["path"])

    with app_client(tmp_path / "target-runtime") as target_client:
        started = target_client.post(
            "/packages/import", json={"path": str(package), "decision": "SafeOnly"}
        )
        imported = wait_for_job(target_client, started.json()["jobId"])
        assert imported["state"] == "Succeeded", imported
        response = target_client.get(f"/songs/{song['songId']}/clip")
        assert response.status_code == 200, response.text
        assert response.content == clip_bytes


def test_package_import_remaps_manifest_when_same_source_has_a_local_song_id(
    tmp_path: Path,
) -> None:
    source = tmp_path / "same-song.wav"
    write_wav(source)
    with app_client(tmp_path / "source-runtime", ai_providers=(FakeAiProvider(),)) as source_client:
        source_song, _ = make_ready_and_export(source_client, source)
        editor = source_client.get(f"/songs/{source_song['songId']}/editor").json()
        saved = source_client.put(
            f"/songs/{source_song['songId']}/editor",
            json={"expectedRevision": editor["revision"], "document": editor["document"]},
        )
        assert saved.status_code == 200, saved.text
        exported = source_client.post(f"/packages/export/{source_song['songId']}")
        export_job = wait_for_job(source_client, exported.json()["jobId"])
        assert export_job["state"] == "Succeeded", export_job
        package = Path(export_job["report"]["path"])

    target_root = tmp_path / "target-runtime"
    with app_client(target_root, ai_providers=(FakeAiProvider(),)) as target_client:
        target_song, _ = make_ready_and_export(target_client, source)
        assert target_song["songId"] != source_song["songId"]
        inspected = target_client.post("/packages/inspect", json={"path": str(package)}).json()
        assert inspected["conflict"] == "NewerRevision"

        started = target_client.post(
            "/packages/import",
            json={"path": str(package), "decision": "SafeOnly"},
        )
        job = wait_for_job(target_client, started.json()["jobId"])
        assert job["state"] == "Succeeded", job
        assert job["report"]["songId"] == target_song["songId"]
        imported_song_id = target_song["songId"]

    with app_client(target_root, ai_providers=(FakeAiProvider(),)) as restarted_client:
        imported = restarted_client.get(f"/songs/{imported_song_id}")
        assert imported.status_code == 200, imported.text
        assert imported.json()["status"] == "Ready"


def test_exported_package_preserves_recognized_song_metadata(tmp_path: Path) -> None:
    source = tmp_path / "recognized.wav"
    write_wav(source)
    with app_client(
        tmp_path / "source-runtime",
        ai_providers=(FakeAiProvider(),),
        recognition_provider=RichRecognitionProvider(),
    ) as source_client:
        song, package = make_ready_and_export(source_client, source)
        source_song = source_client.get(f"/songs/{song['songId']}").json()

    with app_client(tmp_path / "target-runtime") as target_client:
        started = target_client.post(
            "/packages/import",
            json={"path": str(package), "decision": "SafeOnly"},
        )
        job = wait_for_job(target_client, started.json()["jobId"])
        assert job["state"] == "Succeeded", job
        imported = target_client.get(f"/songs/{song['songId']}").json()

    for field in (
        "title",
        "artist",
        "album",
        "genre",
        "artworkUrl",
        "videoUrl",
        "recognitionProvider",
    ):
        assert imported[field] == source_song[field], field
    assert _package_json(package)["songIdentity"]["recognitionExternalId"] == "track-123"


def test_checksum_failure_does_not_publish_song(tmp_path: Path) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "source-runtime", ai_providers=(FakeAiProvider(),)) as source_client:
        song, package = make_ready_and_export(source_client, source)

    tampered = tmp_path / "tampered.zip"
    _rewrite_zip(package, tampered, {"lyricsSync.json": b"tampered"})
    with app_client(tmp_path / "target-runtime") as target_client:
        started = target_client.post(
            "/packages/import",
            json={"path": str(tampered), "decision": "SafeOnly"},
        )
        assert started.status_code == 202, started.text
        job = wait_for_job(target_client, started.json()["jobId"])
        assert job["state"] == "Failed"
        assert job["error"]["code"] == "PackageInvalid"
        assert target_client.get(f"/songs/{song['songId']}").status_code == 404


def test_inspection_distinguishes_newer_older_and_divergent_revision(tmp_path: Path) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        _, package = make_ready_and_export(client, source)
        payload = _package_json(package)

        newer = tmp_path / "newer.zip"
        _rewrite_manifest(
            package, newer, {**payload, "revision": 999, "revisionFingerprint": "f" * 64}
        )
        older = tmp_path / "older.zip"
        _rewrite_manifest(
            package, older, {**payload, "revision": 0, "revisionFingerprint": "e" * 64}
        )
        divergent = tmp_path / "divergent.zip"
        _rewrite_manifest(package, divergent, {**payload, "revisionFingerprint": "d" * 64})

        assert (
            client.post("/packages/inspect", json={"path": str(newer)}).json()["conflict"]
            == "NewerRevision"
        )
        assert (
            client.post("/packages/inspect", json={"path": str(older)}).json()["conflict"]
            == "OlderRevision"
        )
        assert (
            client.post("/packages/inspect", json={"path": str(divergent)}).json()["conflict"]
            == "DivergentRevision"
        )


def _package_json(archive: Path) -> dict[str, object]:
    with zipfile.ZipFile(archive, "r") as bundle:
        return json.loads(bundle.read("package.json").decode("utf-8"))


def _rewrite_manifest(source: Path, target: Path, manifest: dict[str, object]) -> None:
    _rewrite_zip(source, target, {"package.json": json.dumps(manifest).encode("utf-8")})


def _rewrite_zip(source: Path, target: Path, replacements: dict[str, bytes]) -> None:
    with zipfile.ZipFile(source, "r") as original, zipfile.ZipFile(target, "w") as changed:
        for info in original.infolist():
            if info.is_dir():
                continue
            payload = replacements.get(info.filename, original.read(info.filename))
            changed.writestr(info.filename, payload)


def test_corrupt_archive_and_too_new_package_are_rejected(tmp_path: Path) -> None:
    corrupt = tmp_path / "corrupt.zip"
    corrupt.write_bytes(b"not-a-zip")
    with app_client(tmp_path / "corrupt-runtime") as client:
        response = client.post("/packages/inspect", json={"path": str(corrupt)})
        assert response.status_code == 400
        assert response.json()["code"] == "PackageInvalid"

    source = tmp_path / "song-too-new.wav"
    write_wav(source)
    with app_client(tmp_path / "source-too-new", ai_providers=(FakeAiProvider(),)) as source_client:
        _, package = make_ready_and_export(source_client, source)
    manifest = _package_json(package)
    too_new = tmp_path / "too-new.zip"
    _rewrite_manifest(package, too_new, {**manifest, "packageVersion": 999})

    with app_client(tmp_path / "target-too-new") as target_client:
        inspected = target_client.post("/packages/inspect", json={"path": str(too_new)})
        assert inspected.status_code == 200, inspected.text
        assert inspected.json()["compatibility"] == "TooNew"
        started = target_client.post(
            "/packages/import", json={"path": str(too_new), "decision": "SafeOnly"}
        )
        assert started.status_code == 202, started.text
        job = wait_for_job(target_client, started.json()["jobId"])
        assert job["state"] == "Failed"
        assert job["error"]["code"] == "PackageVersionUnsupported"
