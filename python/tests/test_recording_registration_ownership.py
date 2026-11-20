from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider

pytestmark = pytest.mark.integration


def test_registration_rejects_another_recordings_file_without_side_effects(tmp_path: Path) -> None:
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        first = client.post("/recordings/target").json()
        second = client.post("/recordings/target").json()
        path = Path(first["filePath"])
        write_wav(path)
        original = path.read_bytes()
        descriptors = {
            Path(target["filePath"]).parent / "recording-recovery.json"
            for target in (first, second)
        }
        recovery_before = {descriptor: descriptor.read_bytes() for descriptor in descriptors}
        history_before = client.get("/history").json()

        response = client.post(
            "/recordings", json=_registration_payload(second["recordingId"], path)
        )

        assert response.status_code == 400, response.text
        assert response.json()["code"] == "InvalidRecording"
        assert client.get("/recordings").json()["total"] == 0
        assert client.get("/history").json() == history_before
        assert path.read_bytes() == original
        assert {
            descriptor: descriptor.read_bytes() for descriptor in descriptors
        } == recovery_before


def test_registration_accepts_its_own_resolved_file_and_preserves_idempotency(
    tmp_path: Path,
) -> None:
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        target = client.post("/recordings/target").json()
        path = Path(target["filePath"])
        write_wav(path)
        alias = path.parent / ".." / path.parent.name / path.name
        response = client.post(
            "/recordings", json=_registration_payload(target["recordingId"], alias)
        )
        assert response.status_code == 201, response.text
        assert response.json()["filePath"] == str(path.resolve())
        repeated = client.post(
            "/recordings",
            json=_registration_payload(target["recordingId"], tmp_path / "missing.wav"),
        )
        assert repeated.status_code == 201, repeated.text
        assert repeated.json() == response.json()
        assert client.get("/recordings").json()["total"] == 1
        assert client.get("/history").json()["total"] == 1
        assert not (path.parent / "recording-recovery.json").exists()
        assert client.delete(f"/recordings/{target['recordingId']}").status_code == 204
        assert not path.exists()


@pytest.mark.parametrize("placement", ["root", "nested"])
def test_registration_requires_the_immediate_owned_directory(
    tmp_path: Path, placement: str
) -> None:
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        target = client.post("/recordings/target").json()
        owned = Path(target["filePath"])
        path = (
            owned.parent.parent / owned.name
            if placement == "root"
            else owned.parent / "nested" / target["recordingId"] / owned.name
        )
        write_wav(path)
        original = path.read_bytes()
        descriptor = owned.parent / "recording-recovery.json"
        recovery_before = descriptor.read_bytes()
        response = client.post(
            "/recordings", json=_registration_payload(target["recordingId"], path)
        )
        assert response.status_code == 400, response.text
        assert response.json()["code"] == "InvalidRecording"
        assert client.get("/recordings").json()["total"] == 0
        assert path.read_bytes() == original
        assert descriptor.read_bytes() == recovery_before


def _registration_payload(recording_id: str, path: Path) -> dict[str, object]:
    return {
        "recordingId": recording_id,
        "filePath": str(path),
        "duration": 1.0,
        "sampleRate": 16_000,
        "channels": 1,
        "createdAt": datetime.now(UTC).isoformat(),
    }
