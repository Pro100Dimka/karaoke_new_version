from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from threading import Event, current_thread

import pytest
from fastapi.testclient import TestClient

from backend.domain_errors import NotFoundError
from backend.infrastructure.sql_recordings import SqlRecordingRepository
from backend.recordings.domain import Recording
from tests.conftest import write_wav


def test_rename_returns_not_found_when_recording_was_deleted_after_loading(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = client.post("/recordings/target").json()
    path = Path(target["filePath"])
    write_wav(path)
    recording = Recording(target["recordingId"], path, 1, 16000, 1, datetime.now(UTC))
    container = client.app.state.container
    with container.database.create() as transaction:
        transaction.recordings.add(recording)
        transaction.commit()
    entered, release = Event(), Event()
    get = SqlRecordingRepository.get

    def paused_get(repository: SqlRecordingRepository, identity: str) -> Recording | None:
        result = get(repository, identity)
        if current_thread().name.startswith("paused-rename"):
            entered.set()
            assert release.wait(10), "The concurrent deletion did not finish"
        return result

    monkeypatch.setattr(SqlRecordingRepository, "get", paused_get)
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="paused-rename") as pool:
        pending = pool.submit(container.recordings.update.execute, recording.recording_id, "Take")
        try:
            assert entered.wait(10), "Rename did not load the recording"
            response = client.delete(f"/recordings/{recording.recording_id}")
            assert response.status_code == 204, response.text
        finally:
            release.set()
        with pytest.raises(NotFoundError) as failure:
            pending.result(timeout=10)

    assert failure.value.code == "RecordingNotFound"
    assert client.get(f"/recordings/{recording.recording_id}").status_code == 404
    assert not path.parent.exists()
