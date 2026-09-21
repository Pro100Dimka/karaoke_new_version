from __future__ import annotations

import pytest
from datetime import UTC, datetime
from pathlib import Path

from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.helpers import import_song, wait_for_job


pytestmark = pytest.mark.integration


def ready_song(client, source: Path) -> dict[str, object]:
    song = import_song(client, source)
    started = client.post(
        f"/songs/{song['songId']}/processing",
        json={"mode": "Fast", "onlineLyrics": False},
    )
    job = wait_for_job(client, started.json()["jobId"])
    assert job["state"] == "Succeeded", job
    return client.get(f"/songs/{song['songId']}").json()


def register_recording(
    client, song: dict[str, object], *, frequency: float = 440.0
) -> dict[str, object]:
    target = client.post("/recordings/target")
    assert target.status_code == 200, target.text
    payload = target.json()
    path = Path(payload["filePath"])
    write_wav(path, frequency=frequency)
    response = client.post(
        "/recordings",
        json={
            "recordingId": payload["recordingId"],
            "filePath": str(path),
            "duration": 1.0,
            "sampleRate": 16_000,
            "channels": 1,
            "createdAt": datetime.now(UTC).isoformat(),
            "songId": song["songId"],
            "songRevision": song["activeRevision"],
            "gaps": [],
            "sessionMetadata": {"session": "test"},
        },
        headers={"Idempotency-Key": "recording-register"},
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_recording_registration_is_idempotent_and_paginated(tmp_path: Path) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song = ready_song(client, source)
        recording = register_recording(client, song)

        fetched = client.get(f"/recordings/{recording['recordingId']}")
        page = client.get(
            "/recordings", params={"song_id": song["songId"], "limit": 1, "offset": 0}
        )

        assert fetched.status_code == 200
        assert page.status_code == 200
        assert page.json()["total"] == 1
        assert page.json()["items"][0]["recordingId"] == recording["recordingId"]


def test_recording_rejects_metadata_mismatch(tmp_path: Path) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song = ready_song(client, source)
        target = client.post("/recordings/target").json()
        path = Path(target["filePath"])
        write_wav(path)

        response = client.post(
            "/recordings",
            json={
                "recordingId": target["recordingId"],
                "filePath": str(path),
                "duration": 1.0,
                "sampleRate": 48_000,
                "channels": 1,
                "createdAt": datetime.now(UTC).isoformat(),
                "songId": song["songId"],
                "songRevision": song["activeRevision"],
            },
        )

        assert response.status_code == 400
        assert response.json()["code"] == "InvalidRecording"


def test_offline_analysis_succeeds_and_becomes_stale_after_project_revision(tmp_path: Path) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song = ready_song(client, source)
        recording = register_recording(client, song)
        started = client.post(f"/recordings/{recording['recordingId']}/analysis")
        assert started.status_code == 202, started.text
        job = wait_for_job(client, started.json()["jobId"])
        assert job["state"] == "Succeeded", job
        analyses = client.get(f"/recordings/{recording['recordingId']}/analyses").json()
        assert analyses[0]["state"] == "Succeeded"
        analysis_id = analyses[0]["analysisId"]
        assert analyses[0]["pitchAccuracyPercent"] is not None

        editor = client.get(f"/songs/{song['songId']}/editor").json()
        saved = client.put(
            f"/songs/{song['songId']}/editor",
            json={"expectedRevision": editor["revision"], "document": editor["document"]},
        )
        assert saved.status_code == 200, saved.text
        stale = client.get(f"/recordings/analysis/{analysis_id}")

        assert stale.status_code == 200
        assert stale.json()["state"] == "Stale"


def test_delete_recording_removes_owned_file_and_metadata(tmp_path: Path) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song = ready_song(client, source)
        recording = register_recording(client, song)
        path = Path(recording["filePath"])
        assert path.is_file()

        response = client.delete(f"/recordings/{recording['recordingId']}")

        assert response.status_code == 204
        assert not path.exists()
        assert client.get(f"/recordings/{recording['recordingId']}").status_code == 404
