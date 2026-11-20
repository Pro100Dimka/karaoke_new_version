from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor, wait
from pathlib import Path

import pytest

from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.helpers import wait_for_job

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("scenario", ["replay", "key_conflict", "duplicate_content"])
def test_overlapping_song_imports_preserve_replay_and_conflict_contracts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, scenario: str
) -> None:
    source, other = tmp_path / "source.wav", tmp_path / "other.wav"
    write_wav(source)
    write_wav(other, frequency=550)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        entered, release = _pause_first_call(client, monkeypatch, "_persist")
        second_source = other if scenario == "key_conflict" else source
        second_key = "other-key" if scenario == "duplicate_content" else "shared-key"
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(_import, client, source, "shared-key")
            try:
                assert entered.wait(10), "First import did not reach persistence"
                second = pool.submit(_import, client, second_source, second_key)
                wait((second,), timeout=1)
            finally:
                release.set()
            responses = [first.result(timeout=10), second.result(timeout=10)]
        expected = [201, 201] if scenario == "replay" else [201, 409]
        assert sorted(response.status_code for response in responses) == expected, [
            response.text for response in responses
        ]
        if scenario == "replay":
            assert responses[0].json()["songId"] == responses[1].json()["songId"]
        else:
            rejected = next(response for response in responses if response.status_code == 409)
            code = "IdempotencyConflict" if scenario == "key_conflict" else "DuplicateSong"
            assert rejected.json()["code"] == code
        _assert_single_import(client)


def test_unrelated_song_imports_do_not_wait_for_another_imports_commit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source, other = tmp_path / "source.wav", tmp_path / "other.wav"
    write_wav(source)
    write_wav(other, frequency=550)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        entered, release = _pause_first_call(client, monkeypatch, "_save")
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(_import, client, source, "first-key")
            try:
                assert entered.wait(10), "First import did not claim its commit"
                second = pool.submit(_import, client, other, "other-key")
                response = second.result(timeout=5)
                assert response.status_code == 201, response.text
            finally:
                release.set()
            assert first.result(timeout=10).status_code == 201
        assert len(client.get("/songs").json()["items"]) == 2


def test_song_import_cancelled_while_waiting_to_commit_preserves_only_the_owner(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        importer = client.app.state.container.songs.import_song
        entered, release = _pause_first_call(client, monkeypatch, "_save")
        body, headers = {"sourcePath": str(source)}, {"Idempotency-Key": "shared-key"}
        first = client.post("/songs/imports", json=body, headers=headers).json()
        try:
            assert entered.wait(10), "First import did not claim its commit"
            waiting = threading.Event()
            persist = importer._persist

            def observed_persist(*args, **kwargs):
                waiting.set()
                return persist(*args, **kwargs)

            monkeypatch.setattr(importer, "_persist", observed_persist)
            second = client.post("/songs/imports", json=body, headers=headers).json()
            assert waiting.wait(10), "Second import did not reach commit"
            cancelled = client.post(f"/jobs/{second['jobId']}/cancel")
            assert cancelled.status_code == 200, cancelled.text
        finally:
            release.set()
        assert wait_for_job(client, first["jobId"])["state"] == "Succeeded"
        assert wait_for_job(client, second["jobId"])["state"] == "Cancelled"
        _assert_single_import(client)


def _pause_first_call(client, monkeypatch: pytest.MonkeyPatch, method: str):
    importer = client.app.state.container.songs.import_song
    persist = getattr(importer, method)
    entered, release = threading.Event(), threading.Event()
    guard = threading.Lock()

    def blocked_persist(*args, **kwargs):
        with guard:
            first = not entered.is_set()
            entered.set()
        if first:
            assert release.wait(10), "Overlapping import did not finish"
        return persist(*args, **kwargs)

    monkeypatch.setattr(importer, method, blocked_persist)
    return entered, release


def _import(client, source: Path, key: str):
    return client.post("/songs", json={"sourcePath": str(source)}, headers={"Idempotency-Key": key})


def _assert_single_import(client) -> None:
    songs = client.get("/songs").json()["items"]
    assert len(songs) == 1
    assert client.get("/history").json()["total"] == 1
    directories = tuple(client.app.state.container.roots.songs.iterdir())
    assert len(directories) == 1
    assert directories[0].name == songs[0]["songId"]
    assert Path(songs[0]["sourcePath"]).is_file()
