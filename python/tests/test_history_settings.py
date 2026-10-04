from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Event, Lock

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


def test_kaggle_settings_store_the_secret_without_returning_it(client) -> None:
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
    assert "kaggleToken" not in fetched.json()
    assert "private-token" not in fetched.text


def test_kaggle_mode_requires_only_the_stable_token(client, monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("AD_VOICE_PROJECT_ENV_FILE", str(tmp_path / "project.env"))
    monkeypatch.setenv("AD_VOICE_ENV_FILE", str(tmp_path / "python.env"))
    monkeypatch.setenv("AD_VOICE_FRONTEND_ENV_FILE", str(tmp_path / "frontend.env"))
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
    assert missing.json()["code"] == "KaggleAuthenticationRequired"
    assert token_only.status_code == 200
    assert token_only.json()["kaggleConfigured"] is True
    assert insecure.status_code == 422
    assert insecure.json()["code"] == "KaggleUrlInvalid"


def test_account_token_is_enough_to_select_kaggle_before_the_first_song(
    client, monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("AD_VOICE_PROJECT_ENV_FILE", str(tmp_path / "project.env"))
    monkeypatch.setenv("AD_VOICE_ENV_FILE", str(tmp_path / "python.env"))
    monkeypatch.setenv("AD_VOICE_FRONTEND_ENV_FILE", str(tmp_path / "frontend.env"))
    saved = client.patch(
        "/settings/environment/KAGGLE_API_TOKEN",
        json={"value": "personal-kaggle-token"},
    )
    assert saved.status_code == 200

    selected = client.patch("/settings", json={"processingBackend": "Kaggle"})

    assert selected.status_code == 200, selected.text
    assert selected.json()["processingBackend"] == "Kaggle"
    assert selected.json()["kaggleConfigured"] is True
    assert "kaggleToken" not in selected.json()


def test_kaggle_account_token_is_migrated_and_kept_separate_from_notebook_token(
    client, monkeypatch, tmp_path: Path
) -> None:
    deployed: dict[str, str] = {}
    notebook_tokens: list[str] = []

    project = tmp_path / "project.env"
    python = tmp_path / "python.env"
    frontend = tmp_path / "frontend.env"
    monkeypatch.setenv("AD_VOICE_PROJECT_ENV_FILE", str(project))
    monkeypatch.setenv("AD_VOICE_ENV_FILE", str(python))
    monkeypatch.setenv("AD_VOICE_FRONTEND_ENV_FILE", str(frontend))
    configured = client.patch(
        "/settings",
        json={"processingBackend": "Kaggle", "kaggleToken": "personal-kaggle-token"},
    )
    assert configured.status_code == 200, configured.text

    def login(self) -> str:
        deployed["login_account_token"] = self._account_token
        return "Authenticated"

    def deploy(self, token: str, discovery_url: str, notebook_slug: str):
        from backend.infrastructure.kaggle_notebook_automation import KaggleDeployment

        deployed.update(
            token=token,
            discovery_url=discovery_url,
            deploy_account_token=self._account_token,
            notebook_slug=notebook_slug,
        )
        notebook_tokens.append(token)
        return KaggleDeployment(
            url="https://www.kaggle.com/code/singer/ad-voice-gpu",
            message="Notebook started",
        )

    monkeypatch.setattr("backend.api.settings_routes.KaggleNotebookAutomation.login", login)
    monkeypatch.setattr("backend.api.settings_routes.KaggleNotebookAutomation.deploy", deploy)
    monkeypatch.setattr(
        "backend.api.settings_routes.KaggleAiProvider.validate_configuration",
        lambda self: deployed.update(notebook_ready="yes"),
    )

    login = client.post("/settings/kaggle/login")
    launched = client.post("/settings/kaggle/deploy")
    relaunched = client.post("/settings/kaggle/deploy")

    assert login.json() == {"state": "valid", "message": "Authenticated", "url": None}
    assert launched.json() == {
        "state": "valid",
        "message": "Notebook started",
        "url": "https://www.kaggle.com/code/singer/ad-voice-gpu",
    }
    assert relaunched.status_code == 200
    assert deployed["login_account_token"] == "personal-kaggle-token"
    assert deployed["deploy_account_token"] == "personal-kaggle-token"
    assert len(deployed["token"]) >= 32
    assert deployed["token"] != "personal-kaggle-token"
    assert notebook_tokens == [deployed["token"], deployed["token"]]
    assert deployed["notebook_slug"].startswith("ad-voice-gpu-")
    assert len(deployed["notebook_slug"]) > len("ad-voice-gpu-")
    assert deployed["notebook_ready"] == "yes"
    assert deployed["discovery_url"] == "http://130.61.169.61:8081"
    settings = client.get("/settings").json()
    assert settings["kaggleConfigured"] is True
    assert settings["kaggleUrl"] == "https://www.kaggle.com/code/singer/ad-voice-gpu"
    assert "kaggleToken" not in settings
    assert project.read_text(encoding="utf-8").strip() == (
        "KAGGLE_API_TOKEN='personal-kaggle-token'"
    )


def test_parallel_kaggle_deploy_requests_share_one_server_operation(
    client, monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("AD_VOICE_PROJECT_ENV_FILE", str(tmp_path / "project.env"))
    monkeypatch.setenv("AD_VOICE_ENV_FILE", str(tmp_path / "python.env"))
    monkeypatch.setenv("AD_VOICE_FRONTEND_ENV_FILE", str(tmp_path / "frontend.env"))
    configured = client.patch(
        "/settings",
        json={"processingBackend": "Kaggle", "kaggleToken": "personal-kaggle-token"},
    )
    assert configured.status_code == 200
    entered = Event()
    release = Event()
    second_deploy_started = Event()
    calls: list[str] = []
    calls_lock = Lock()

    def deploy(self, token: str, discovery_url: str, notebook_slug: str):
        from backend.infrastructure.kaggle_notebook_automation import KaggleDeployment

        with calls_lock:
            calls.append(token)
            if len(calls) > 1:
                second_deploy_started.set()
        entered.set()
        assert release.wait(2)
        return KaggleDeployment(
            url="https://www.kaggle.com/code/singer/ad-voice-gpu",
            message="Notebook started",
        )

    monkeypatch.setattr("backend.api.settings_routes.KaggleNotebookAutomation.deploy", deploy)
    monkeypatch.setattr(
        "backend.api.settings_routes.KaggleAiProvider.validate_configuration",
        lambda self: None,
    )

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(client.post, "/settings/kaggle/deploy")
        assert entered.wait(1)
        second = executor.submit(client.post, "/settings/kaggle/deploy")
        shared_operation = not second_deploy_started.wait(0.1)
        release.set()
        responses = [first.result(), second.result()]

    assert shared_operation
    assert [response.status_code for response in responses] == [200, 200]
    assert len(calls) == 1
    assert responses[0].json() == responses[1].json()


def test_switching_from_kaggle_to_local_stops_the_running_notebook(client, monkeypatch) -> None:
    stopped: list[str] = []
    configured = client.patch(
        "/settings",
        json={"processingBackend": "Kaggle", "kaggleToken": "private-token"},
    )
    assert configured.status_code == 200
    monkeypatch.setattr(
        "backend.api.settings_routes.KaggleAiProvider.shutdown",
        lambda self: stopped.append("stopped"),
    )

    response = client.patch("/settings", json={"processingBackend": "Local"})

    assert response.status_code == 200
    assert response.json()["processingBackend"] == "Local"
    assert stopped == ["stopped"]
