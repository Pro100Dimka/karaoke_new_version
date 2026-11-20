from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import UTC, datetime
from pathlib import Path

import pytest

from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider

pytestmark = pytest.mark.integration


def test_overlapping_registrations_of_one_recording_return_the_same_saved_take(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        payload = _recording_payload(client)
        path = Path(payload["filePath"])
        original = path.read_bytes()
        entered, release = _pause_first_persist(client, monkeypatch)
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(client.post, "/recordings", json=payload)
            try:
                assert entered.wait(10), "First registration did not reach persistence"
                second = pool.submit(client.post, "/recordings", json=payload)
                wait((second,), timeout=1)
            finally:
                release.set()
            responses = [first.result(timeout=10), second.result(timeout=10)]
        assert [response.status_code for response in responses] == [201, 201], [
            response.text for response in responses
        ]
        assert responses[0].json() == responses[1].json()
        assert client.get("/recordings").json()["total"] == 1
        assert client.get("/history").json()["total"] == 1
        assert path.read_bytes() == original
        assert not (path.parent / "recording-recovery.json").exists()


def test_registering_another_take_does_not_wait_for_a_pending_recording(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        first_payload, second_payload = _recording_payload(client), _recording_payload(client)
        entered, release = _pause_first_persist(client, monkeypatch)
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(client.post, "/recordings", json=first_payload)
            try:
                assert entered.wait(10), "First registration did not reach persistence"
                second = pool.submit(client.post, "/recordings", json=second_payload)
                response = second.result(timeout=5)
                assert response.status_code == 201, response.text
            finally:
                release.set()
            assert first.result(timeout=10).status_code == 201
        assert client.get("/recordings").json()["total"] == 2
        assert client.get("/history").json()["total"] == 2


def _pause_first_persist(client, monkeypatch: pytest.MonkeyPatch):
    register = client.app.state.container.recordings.register
    persist = register._persist
    entered, release = threading.Event(), threading.Event()
    guard = threading.Lock()

    def blocked_persist(*args):
        with guard:
            first = not entered.is_set()
            entered.set()
        if first:
            assert release.wait(10), "Overlapping registration did not finish"
        return persist(*args)

    monkeypatch.setattr(register, "_persist", blocked_persist)
    return entered, release


def _recording_payload(client) -> dict[str, object]:
    target = client.post("/recordings/target").json()
    write_wav(Path(target["filePath"]))
    return {
        **target,
        "duration": 1.0,
        "sampleRate": 16_000,
        "channels": 1,
        "createdAt": datetime.now(UTC).isoformat(),
    }
