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


@pytest.mark.parametrize(
    "field",
    [
        "selectedSeparationProvider",
        "selectedAsrProvider",
        "selectedPitchProvider",
        "selectedAlignmentProvider",
    ],
)
def test_settings_can_clear_selected_provider(client, field: str) -> None:
    assert client.patch("/settings", json={field: "local-provider"}).status_code == 200

    cleared = client.patch("/settings", json={field: ""})

    assert cleared.status_code == 200
    assert cleared.json()[field] is None
    assert client.get("/settings").json()[field] is None


def test_settings_can_clear_kaggle_url(client) -> None:
    configured = client.patch(
        "/settings",
        json={
            "processingBackend": "Kaggle",
            "kaggleUrl": "https://example.gradio.live",
            "kaggleToken": "private-token",
        },
    )
    assert configured.status_code == 200

    cleared = client.patch("/settings", json={"kaggleUrl": ""})

    assert cleared.status_code == 200
    assert cleared.json()["kaggleUrl"] is None
    assert client.get("/settings").json()["kaggleUrl"] is None


def test_settings_reject_invalid_cpu_budget(client) -> None:
    response = client.patch("/settings", json={"cpuThreads": 0})
    assert response.status_code == 422
    assert response.json()["code"] == "ValidationError"


@pytest.mark.parametrize("backend", ["Oracle", "Kaggle"])
def test_remote_settings_select_oracle_without_notebook_credentials(client, backend):
    response = client.patch("/settings", json={"processingBackend": backend})
    assert response.status_code == 200, response.text
    assert response.json()["processingBackend"] == "Oracle"
    assert client.get("/settings").json()["processingBackend"] == "Oracle"


def test_stored_kaggle_selection_is_migrated_to_oracle():
    from backend.infrastructure.orm import SettingsRow
    from backend.infrastructure.sql_settings import _to_domain
    from backend.settings.domain import ProcessingBackend

    row = SettingsRow(settings_schema_version=2, payload_json='{"processingBackend":"Kaggle"}')
    assert _to_domain(row).processing_backend is ProcessingBackend.ORACLE


def test_processing_access_key_is_write_only_and_separate_from_worker_key(client):
    token = "client-test-token-" * 3
    saved = client.patch("/settings/environment/AD_VOICE_PROCESSING_TOKEN", json={"value": token})
    assert saved.status_code == 200
    assert saved.json()["configured"] is True
    assert saved.json()["value"] == ""
    listed = client.get("/settings/environment")
    assert token not in listed.text
    assert all(item["key"] != "AD_VOICE_PROCESSING_WORKER_TOKEN" for item in listed.json())


@pytest.mark.parametrize("online,state", [(True, "valid"), (False, "unverified")])
def test_processing_verification_reports_worker_availability(client, monkeypatch, online, state):
    monkeypatch.setattr(
        "backend.api.settings_routes.OracleAiProvider.validate_configuration",
        lambda self: {"protocolVersion": 1, "workerOnline": online},
    )
    response = client.post("/settings/processing/verify")
    assert response.status_code == 200
    assert response.json()["state"] == state


def test_processing_verification_preserves_connection_error(client, monkeypatch):
    from backend.domain_errors import DependencyError

    def unavailable(self):
        raise DependencyError("ProcessingAccessDenied", "Access key rejected")

    monkeypatch.setattr(
        "backend.api.settings_routes.OracleAiProvider.validate_configuration", unavailable
    )
    response = client.post("/settings/processing/verify")
    assert response.json() == {"state": "invalid", "message": "Access key rejected"}


@pytest.mark.parametrize("action", ["login", "deploy", "verify"])
def test_removed_notebook_actions_are_not_available(client, action):
    assert client.post(f"/settings/kaggle/{action}").status_code == 404


def test_switching_from_oracle_to_local_does_not_stop_shared_worker(client, monkeypatch):
    def unexpected(*args, **kwargs):
        pytest.fail("Switching one client must not contact the shared worker")

    monkeypatch.setattr("backend.infrastructure.processing_transport.ProcessingTransport.request", unexpected)
    assert client.patch("/settings", json={"processingBackend": "Oracle"}).status_code == 200
    response = client.patch("/settings", json={"processingBackend": "Local"})
    assert response.status_code == 200
    assert response.json()["processingBackend"] == "Local"
