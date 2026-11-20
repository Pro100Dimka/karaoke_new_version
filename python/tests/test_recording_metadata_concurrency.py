from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from threading import Event, current_thread

import pytest
from fastapi.testclient import TestClient

from backend.infrastructure.sql_recordings import SqlRecordingRepository
from backend.recordings.domain import Recording
from tests.conftest import write_wav


@pytest.fixture
def preparing_recording(client: TestClient) -> Recording:
    target = client.post("/recordings/target").json()
    path = Path(target["filePath"])
    write_wav(path)
    recording = Recording(
        target["recordingId"],
        path,
        1,
        16000,
        1,
        datetime.now(UTC),
        file_status="Preparing",
        display_name="Original take",
        session_metadata={"capture": "original"},
    )
    with client.app.state.container.database.create() as transaction:
        transaction.recordings.add(recording)
        transaction.commit()
    return recording


@pytest.mark.parametrize("paused_action", ["rename", "finish"])
def test_recording_rename_and_completion_preserve_each_others_fields(
    client: TestClient,
    preparing_recording: Recording,
    monkeypatch: pytest.MonkeyPatch,
    paused_action: str,
) -> None:
    recording_id = preparing_recording.recording_id
    original_audio = preparing_recording.file_path.read_bytes()
    entered, release = Event(), Event()
    get = SqlRecordingRepository.get
    container = client.app.state.container

    def paused_get(repository: SqlRecordingRepository, identity: str) -> Recording | None:
        result = get(repository, identity)
        if current_thread().name.startswith("paused-metadata") and not entered.is_set():
            entered.set()
            assert release.wait(10), "The concurrent metadata edit did not finish"
        return result

    def rename() -> Recording:
        return container.recordings.update.execute(recording_id, "My saved take")

    def finish() -> None:
        container.recordings.register._set_status(recording_id, "Ready")

    monkeypatch.setattr(SqlRecordingRepository, "get", paused_get)
    actions = {"rename": rename, "finish": finish}
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="paused-metadata") as pool:
        pending = pool.submit(actions[paused_action])
        try:
            assert entered.wait(10), "The first metadata edit did not read the recording"
            actions["finish" if paused_action == "rename" else "rename"]()
        finally:
            release.set()
        pending.result(timeout=10)

    response = client.get(f"/recordings/{recording_id}")
    assert response.status_code == 200, response.text
    assert response.json()["displayName"] == "My saved take"
    assert response.json()["fileStatus"] == "Ready"
    with container.database.create() as transaction:
        saved = transaction.recordings.get(recording_id)
    assert saved is not None
    assert saved.session_metadata == {"capture": "original"}
    assert saved.file_path.read_bytes() == original_audio
