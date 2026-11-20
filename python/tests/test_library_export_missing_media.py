from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from tests.conftest import app_client, write_wav
from tests.helpers import import_song, wait_for_job

pytestmark = pytest.mark.integration


def _register_take(client, song):
    target = client.post("/recordings/target")
    assert target.status_code == 200, target.text
    capture = target.json()
    write_wav(Path(capture["filePath"]))
    response = client.post(
        "/recordings",
        json={
            **capture,
            "duration": 1,
            "sampleRate": 16_000,
            "channels": 1,
            "createdAt": datetime.now(UTC).isoformat(),
            "songId": song["songId"],
            "songRevision": song["activeRevision"],
        },
    )
    assert response.status_code == 201, response.text
    assert response.json()["fileStatus"] == "Ready"
    return response.json()


def _export(client):
    started = client.post("/packages/library/export")
    assert started.status_code == 202, started.text
    return wait_for_job(client, started.json()["jobId"])


@pytest.mark.parametrize("has_companion", [False, True])
def test_library_export_rejects_a_missing_recording_without_losing_rows_or_prior_archives(
    tmp_path: Path, has_companion: bool
) -> None:
    source = tmp_path / "Song.wav"
    write_wav(source)
    with app_client(tmp_path / "source-runtime") as client:
        song = import_song(client, source)
        recording = _register_take(client, song)
        media = Path(recording["filePath"])
        original = media.read_bytes()
        companion = media.with_suffix(".session.json")
        if has_companion:
            companion.write_text('{"session":"preserved"}', encoding="utf-8")
        healthy = _export(client)
        assert healthy["state"] == "Succeeded", healthy
        prior_archive = Path(healthy["report"]["path"])
        prior_bytes = prior_archive.read_bytes()
        media.unlink()

        failed = _export(client)

        assert failed["state"] == "Failed", failed
        assert failed["error"]["code"] == "StorageUnavailable"
        assert failed["error"]["details"]["recordingId"] == recording["recordingId"]
        assert failed["error"]["details"]["path"] == str(media)
        assert failed["report"] is None
        assert set(prior_archive.parent.glob("*.zip")) == {prior_archive}
        assert prior_archive.read_bytes() == prior_bytes
        current = client.get(f"/recordings/{recording['recordingId']}")
        assert current.status_code == 200, current.text
        assert current.json()["filePath"] == recording["filePath"]
        assert client.get("/recordings").json()["total"] == 1
        assert client.get(f"/songs/{song['songId']}").status_code == 200
        if has_companion:
            assert companion.read_text(encoding="utf-8") == '{"session":"preserved"}'

        media.write_bytes(original)
        retried = _export(client)
        assert retried["state"] == "Succeeded", retried

    with app_client(tmp_path / "target-runtime") as recipient:
        started = recipient.post(
            "/packages/library/import", json={"path": retried["report"]["path"]}
        )
        assert started.status_code == 202, started.text
        imported = wait_for_job(recipient, started.json()["jobId"])
        assert imported["state"] == "Succeeded", imported
        restored = recipient.get(f"/recordings/{recording['recordingId']}")
        assert restored.status_code == 200, restored.text
        restored_media = Path(restored.json()["filePath"])
        assert restored_media.read_bytes() == original
        if has_companion:
            assert restored_media.with_suffix(".session.json").read_text(encoding="utf-8") == (
                '{"session":"preserved"}'
            )
