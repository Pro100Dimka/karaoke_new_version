from pathlib import Path
from datetime import UTC, datetime

import pytest

from tests.conftest import app_client, write_wav


@pytest.mark.parametrize("create_file", [False, True])
def test_delete_discards_an_empty_unregistered_target(tmp_path: Path, create_file: bool) -> None:
    with app_client(tmp_path / "runtime") as client:
        target = client.post("/recordings/target").json()
        path = Path(target["filePath"])
        if create_file:
            write_wav(path, seconds=0)
        response = client.delete(f"/recordings/{target['recordingId']}")
        assert response.status_code == 204, response.text
        assert not path.parent.exists()
        assert client.get("/recordings").json()["total"] == 0


@pytest.mark.parametrize("content", ["audio", "unfinished", "extra_file"])
def test_empty_cleanup_preserves_nonempty_or_unrecognized_takes(tmp_path: Path, content: str) -> None:
    with app_client(tmp_path / "runtime") as client:
        target = client.post("/recordings/target").json()
        path = Path(target["filePath"])
        write_wav(path, seconds=1 if content == "audio" else 0)
        if content == "unfinished":
            with path.open("ab") as stream:
                stream.write(b"unfinalized PCM")
        if content == "extra_file":
            (path.parent / "recording-recovery.json").write_text("{}")
        original = path.read_bytes()
        response = client.delete(f"/recordings/{target['recordingId']}")
        assert response.status_code == 409, response.text
        assert path.read_bytes() == original


def test_empty_cleanup_rejects_path_components(tmp_path: Path) -> None:
    with app_client(tmp_path / "runtime") as client:
        response = client.delete("/recordings/..%5Coutside")
        assert response.status_code == 400, response.text


@pytest.mark.parametrize("recording_id", ["../escape", "..\\escape", "C:\\outside", ".", ""])
def test_registration_rejects_recording_ids_that_can_escape_storage(tmp_path: Path, recording_id: str) -> None:
    with app_client(tmp_path / "runtime") as client:
        target = client.post("/recordings/target").json()
        path = Path(target["filePath"])
        write_wav(path)
        response = client.post("/recordings", json={
            "recordingId": recording_id, "filePath": str(path), "duration": 1,
            "sampleRate": 16000, "channels": 1, "createdAt": datetime.now(UTC).isoformat(),
        })
        assert response.status_code in {400, 422}, response.text
        assert path.exists()
        assert client.get("/recordings").json()["total"] == 0
