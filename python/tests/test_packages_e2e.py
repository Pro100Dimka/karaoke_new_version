from __future__ import annotations

import pytest
import json
import zipfile
from pathlib import Path

from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.helpers import import_song, wait_for_job
from backend.songs.recognition import RecognizedSong


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


def test_package_import_remaps_manifest_when_same_source_has_a_local_song_id(tmp_path: Path) -> None:
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
