from __future__ import annotations

from pathlib import Path

import pytest
import httpx
from dotenv import dotenv_values
from fastapi.testclient import TestClient

from backend.settings.environment import EnvironmentSettingsStore, default_environment_store


def test_unused_oci_credentials_are_not_exposed_as_application_settings(
    tmp_path: Path,
) -> None:
    project = tmp_path / "project.env"
    project.write_text(
        "OCI_CONFIG_FILE=C:/secrets/oci/config\nOCI_PROFILE=DEFAULT\n",
        encoding="utf-8",
    )

    entries = EnvironmentSettingsStore(project, tmp_path / "python.env").read()

    assert all(entry.group != "oci" for entry in entries)
    assert all(not entry.key.startswith("OCI_") for entry in entries)


def test_internal_runtime_paths_are_not_exposed_as_user_settings(
    tmp_path: Path,
) -> None:
    project = tmp_path / "project.env"
    python = tmp_path / "python.env"
    frontend = tmp_path / ".env.local"
    frontend.write_text(
        "AD_VOICE_PYTHON=C:/runtime/python.exe\n"
        "AD_VOICE_AUDIO_SERVICE=C:/runtime/AudioService.exe\n",
        encoding="utf-8",
    )
    store = EnvironmentSettingsStore(project, python, frontend_file=frontend)

    keys = {entry.key for entry in store.read()}

    assert "AD_VOICE_PYTHON" not in keys
    assert "AD_VOICE_AUDIO_SERVICE" not in keys


def test_room_server_deployment_files_are_managed_and_validated(
    tmp_path: Path,
) -> None:
    private_key = tmp_path / "room_server"
    private_key.write_text(
        "-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----\n",
        encoding="utf-8",
    )
    known_hosts = tmp_path / "known_hosts"
    known_hosts.write_text("rooms.example ssh-ed25519 AAAA\n", encoding="utf-8")
    project = tmp_path / "project.env"
    project.write_text(
        f"AD_VOICE_ROOM_SERVER_SSH_KEY={private_key}\n"
        f"AD_VOICE_ROOM_SERVER_KNOWN_HOSTS={known_hosts}\n"
        "AD_VOICE_ROOM_SERVER_SSH_USER=ubuntu\n",
        encoding="utf-8",
    )

    entries = {
        entry.key: entry
        for entry in EnvironmentSettingsStore(project, tmp_path / "python.env").read()
    }

    assert entries["AD_VOICE_ROOM_SERVER_SSH_KEY"].state == "valid"
    assert entries["AD_VOICE_ROOM_SERVER_KNOWN_HOSTS"].state == "valid"
    assert entries["AD_VOICE_ROOM_SERVER_SSH_USER"].state == "valid"


def test_environment_values_persist_without_erasing_unrelated_keys(
    tmp_path: Path,
) -> None:
    project = tmp_path / "project.env"
    python = tmp_path / "python.env"
    project.write_text("AD_VOICE_ROOM_SERVER_RELAY_PORT=40000\nKEEP_ME=value\n", encoding="utf-8")
    python.write_text("AD_VOICE_AUDD_TOKEN=old-secret\n", encoding="utf-8")
    store = EnvironmentSettingsStore(project, python)

    result = store.save("AD_VOICE_ROOM_SERVER_RELAY_PORT", "41000")

    assert result.state == "valid"
    assert dotenv_values(project)["AD_VOICE_ROOM_SERVER_RELAY_PORT"] == "41000"
    assert "KEEP_ME=value" in project.read_text(encoding="utf-8")
    assert "AD_VOICE_AUDD_TOKEN=old-secret" in python.read_text(encoding="utf-8")


def test_room_settings_expose_one_host_and_two_distinct_ports(tmp_path: Path) -> None:
    frontend = tmp_path / ".env.local"
    frontend.write_text(
        "AD_VOICE_ROOM_SERVER=http://rooms.example:8181\n"
        "AD_VOICE_ROOM_SERVER_RELAY_PORT=40000\n",
        encoding="utf-8",
    )

    entries = {
        entry.key: entry
        for entry in EnvironmentSettingsStore(
            tmp_path / "project.env",
            tmp_path / "python.env",
            frontend_file=frontend,
        ).read()
    }

    assert "AD_VOICE_ROOM_SERVER" not in entries
    assert entries["AD_VOICE_ROOM_SERVER_HOST"].value == "rooms.example"
    assert entries["AD_VOICE_ROOM_SERVER_PORT"].value == "8181"
    assert entries["AD_VOICE_ROOM_SERVER_RELAY_PORT"].value == "40000"


def test_environment_secret_values_are_returned_until_release_hardening(tmp_path: Path) -> None:
    project = tmp_path / "project.env"
    python = tmp_path / "python.env"
    python.write_text("AD_VOICE_AUDD_TOKEN=private-token\n", encoding="utf-8")

    entries = EnvironmentSettingsStore(project, python).read()
    token = next(item for item in entries if item.key == "AD_VOICE_AUDD_TOKEN")

    assert token.configured is True
    assert token.value == "private-token"


def test_kaggle_account_token_is_managed_as_a_user_environment_setting(
    tmp_path: Path,
) -> None:
    project = tmp_path / "project.env"
    store = EnvironmentSettingsStore(project, tmp_path / "python.env")

    saved = store.save("KAGGLE_API_TOKEN", "personal-kaggle-token")
    listed = {entry.key: entry for entry in store.read()}

    assert saved.group == "kaggle"
    assert saved.kind == "secret"
    assert listed["KAGGLE_API_TOKEN"].value == "personal-kaggle-token"
    assert dotenv_values(project)["KAGGLE_API_TOKEN"] == "personal-kaggle-token"


def test_default_store_uses_the_configured_writable_frontend_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = tmp_path / "project.env"
    python = tmp_path / "python.env"
    frontend = tmp_path / "frontend.env"
    monkeypatch.setenv("AD_VOICE_PROJECT_ENV_FILE", str(project))
    monkeypatch.setenv("AD_VOICE_ENV_FILE", str(python))
    monkeypatch.setenv("AD_VOICE_FRONTEND_ENV_FILE", str(frontend))

    default_environment_store().save("AD_VOICE_ROOM_SERVER_HOST", "rooms.example")

    assert dotenv_values(frontend)["AD_VOICE_ROOM_SERVER_HOST"] == "rooms.example"


def test_environment_settings_api_saves_and_returns_validation(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = tmp_path / "project.env"
    python = tmp_path / "python.env"
    monkeypatch.setenv("AD_VOICE_PROJECT_ENV_FILE", str(project))
    monkeypatch.setenv("AD_VOICE_ENV_FILE", str(python))

    saved = client.patch(
        "/settings/environment/AD_VOICE_ROOM_SERVER_RELAY_PORT",
        json={"value": "70000"},
    )
    listed = client.get("/settings/environment")

    assert saved.status_code == 200
    assert saved.json()["state"] == "invalid"
    assert listed.status_code == 200
    assert any(
        item["key"] == "AD_VOICE_ROOM_SERVER_RELAY_PORT"
        and item["value"] == "70000"
        for item in listed.json()
    )


def test_environment_token_verification_marks_rejected_audd_token_invalid(
    tmp_path: Path,
) -> None:
    def reject(request: httpx.Request) -> httpx.Response:
        assert request.url == "https://api.audd.io/"
        return httpx.Response(200, json={"status": "error", "error": {"error_code": 900}})

    store = EnvironmentSettingsStore(
        tmp_path / "project.env",
        tmp_path / "python.env",
        httpx.MockTransport(reject),
    )
    store.save("AD_VOICE_AUDD_TOKEN", "expired-token")

    result = store.verify("AD_VOICE_AUDD_TOKEN")

    assert result.state == "invalid"
    assert result.value == "expired-token"
