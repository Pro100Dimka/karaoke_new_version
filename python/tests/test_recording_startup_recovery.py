from __future__ import annotations

import pytest
from datetime import UTC, datetime
from pathlib import Path

from backend.infrastructure.recording_files import LocalRecordingStorage
from backend.recordings.domain import Recording
from backend.storage.domain import StorageRoots
from tests.conftest import app_client, write_wav


pytestmark = pytest.mark.integration


def test_startup_recovers_finalized_orphan_recording_descriptor(tmp_path: Path) -> None:
    root = tmp_path / "runtime"
    roots = StorageRoots.under(root)
    recording_path = roots.recordings / "orphan-recording" / "recording.wav"
    write_wav(recording_path, seconds=1.0)
    storage = LocalRecordingStorage(roots)
    recording = Recording(
        recording_id="orphan-recording",
        file_path=recording_path,
        duration=1.0,
        sample_rate=16_000,
        channels=1,
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    descriptor = storage.write_recovery_descriptor(recording)
    assert descriptor.is_file()

    with app_client(root) as client:
        response = client.get("/recordings/orphan-recording")
        assert response.status_code == 200, response.text
        assert response.json()["recordingId"] == "orphan-recording"
        assert response.json()["fileStatus"] == "RecoveredIncomplete"
        assert (
            "orphan-recording" in client.app.state.container.startup_recovery.recovered_recordings
        )
        assert not descriptor.exists()
