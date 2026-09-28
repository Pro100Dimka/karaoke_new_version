from __future__ import annotations

import pytest
from pathlib import Path

from tests.conftest import write_wav
from tests.helpers import import_song


pytestmark = pytest.mark.integration


def test_history_is_paginated_and_deterministic(client, tmp_path: Path) -> None:
    for index in range(3):
        source = tmp_path / f"history-{index}.wav"
        write_wav(source, frequency=440 + index * 30)
        import_song(client, source, title=f"Song {index}")

    first = client.get("/history", params={"limit": 2, "offset": 0})
    second = client.get("/history", params={"limit": 2, "offset": 2})

    assert first.status_code == 200
    assert second.status_code == 200
    first_payload = first.json()
    second_payload = second.json()
    assert first_payload["total"] == 3
    assert first_payload["limit"] == 2
    assert first_payload["offset"] == 0
    ids = [item["eventId"] for item in [*first_payload["items"], *second_payload["items"]]]
    assert len(ids) == 3
    assert len(ids) == len(set(ids))


def test_settings_update_and_read_round_trip(client) -> None:
    updated = client.patch(
        "/settings",
        json={"computeMode": "CPU", "cpuThreads": 2, "selectedAsrProvider": "local-asr"},
    )
    fetched = client.get("/settings")

    assert updated.status_code == 200, updated.text
    assert fetched.status_code == 200
    assert fetched.json()["computeMode"] == "CPU"
    assert fetched.json()["cpuThreads"] == 2
    assert fetched.json()["selectedAsrProvider"] == "local-asr"


def test_settings_reject_invalid_cpu_budget(client) -> None:
    response = client.patch("/settings", json={"cpuThreads": 0})
    assert response.status_code == 422
    assert response.json()["code"] == "ValidationError"


def test_kaggle_settings_store_and_return_secret_until_release_hardening(client) -> None:
    updated = client.patch(
        "/settings",
        json={
            "processingBackend": "Kaggle",
            "kaggleUrl": "https://example.gradio.live",
            "kaggleToken": "private-token",
        },
    )
    fetched = client.get("/settings")

    assert updated.status_code == 200, updated.text
    assert fetched.json()["processingBackend"] == "Kaggle"
    assert fetched.json()["kaggleUrl"] == "https://example.gradio.live"
    assert fetched.json()["kaggleConfigured"] is True
    assert fetched.json()["kaggleToken"] == "private-token"


def test_kaggle_mode_requires_only_the_stable_token(client) -> None:
    missing = client.patch("/settings", json={"processingBackend": "Kaggle"})
    token_only = client.patch(
        "/settings",
        json={"processingBackend": "Kaggle", "kaggleToken": "private-token"},
    )
    insecure = client.patch(
        "/settings",
        json={
            "processingBackend": "Kaggle",
            "kaggleUrl": "http://example.test",
            "kaggleToken": "private-token",
        },
    )

    assert missing.status_code == 422
    assert missing.json()["code"] == "KaggleNotConfigured"
    assert token_only.status_code == 200
    assert token_only.json()["kaggleConfigured"] is True
    assert insecure.status_code == 422
    assert insecure.json()["code"] == "KaggleUrlInvalid"


def test_kaggle_login_and_deploy_are_available_without_manual_notebook_setup(
    client, monkeypatch
) -> None:
    deployed: dict[str, str] = {}

    monkeypatch.setattr(
        "backend.api.settings_routes.KaggleNotebookAutomation.login",
        lambda self: "Authenticated",
    )

    def deploy(self, token: str, discovery_url: str):
        from backend.infrastructure.kaggle_notebook_automation import KaggleDeployment

        deployed.update(token=token, discovery_url=discovery_url)
        return KaggleDeployment(
            url="https://www.kaggle.com/code/singer/ad-voice-gpu",
            message="Notebook started",
        )

    monkeypatch.setattr(
        "backend.api.settings_routes.KaggleNotebookAutomation.deploy", deploy
    )

    login = client.post("/settings/kaggle/login")
    launched = client.post("/settings/kaggle/deploy")

    assert login.json() == {"state": "valid", "message": "Authenticated", "url": None}
    assert launched.json() == {
        "state": "valid",
        "message": "Notebook started",
        "url": "https://www.kaggle.com/code/singer/ad-voice-gpu",
    }
    assert len(deployed["token"]) >= 32
    assert deployed["discovery_url"] == "http://130.61.169.61:8081"
    assert client.get("/settings").json()["kaggleConfigured"] is True
