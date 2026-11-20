from __future__ import annotations

import os
from pathlib import Path

import httpx
import pytest

from backend.domain_errors import DependencyError
from backend.infrastructure.oracle_ai_provider import processing_connection
from backend.settings.environment import EnvironmentSettingsStore

_TOKEN = "fixture-processing-key-1234567890123456"
_INVALID_ENDPOINTS = [
    pytest.param("AD_VOICE_ROOM_SERVER='https://rooms.example:abc'\n", id="legacy-port"),
    pytest.param("AD_VOICE_ROOM_SERVER_HOST='https://rooms.example'\n", id="host-protocol"),
    pytest.param(
        "AD_VOICE_ROOM_SERVER_HOST=rooms.example\nAD_VOICE_ROOM_SERVER_PORT=70000\n",
        id="modern-port",
    ),
]


@pytest.fixture
def endpoint_file(monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.delenv("AD_VOICE_PROCESSING_URL", raising=False)
    Path(os.environ["AD_VOICE_PROJECT_ENV_FILE"]).write_text(
        f"AD_VOICE_PROCESSING_TOKEN='{_TOKEN}'\n", encoding="utf-8"
    )
    return Path(os.environ["AD_VOICE_FRONTEND_ENV_FILE"])


@pytest.mark.parametrize("settings", _INVALID_ENDPOINTS)
def test_processing_connection_rejects_invalid_saved_address(endpoint_file, settings) -> None:
    endpoint_file.write_text(settings, encoding="utf-8")

    with pytest.raises(DependencyError) as failure:
        processing_connection()

    assert failure.value.code == "ProcessingNotConfigured"


@pytest.mark.parametrize("settings", _INVALID_ENDPOINTS)
def test_token_verification_does_not_request_an_invalid_saved_address(
    endpoint_file: Path, settings: str, tmp_path: Path
) -> None:
    endpoint_file.write_text(settings, encoding="utf-8")
    requests: list[str] = []

    def health(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        return httpx.Response(200, json={"protocolVersion": 1, "workerOnline": True})

    store = EnvironmentSettingsStore(
        Path(os.environ["AD_VOICE_PROJECT_ENV_FILE"]),
        tmp_path / "python.env",
        httpx.MockTransport(health),
        frontend_file=endpoint_file,
        default_values={"AD_VOICE_ROOM_SERVER_PORT": "443"},
    )

    result = store.verify("AD_VOICE_PROCESSING_TOKEN")

    assert requests == []
    assert result.state == "invalid"
    assert result.configured is True


def test_explicit_processing_url_wins_over_unused_invalid_address(
    endpoint_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    endpoint_file.write_text(
        "AD_VOICE_ROOM_SERVER='https://rooms.example:abc'\nAD_VOICE_ROOM_SERVER_PORT=70000\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("AD_VOICE_PROCESSING_URL", "https://chosen.example/processing")

    assert processing_connection() == ("https://chosen.example/processing", _TOKEN)


@pytest.mark.parametrize(("port", "expected"), [("8443", "8443"), ("", "443")])
def test_valid_modern_endpoint_wins_over_unused_invalid_legacy(
    endpoint_file, port, expected
) -> None:
    endpoint_file.write_text(
        "AD_VOICE_ROOM_SERVER='https://rooms.example:abc'\n"
        f"AD_VOICE_ROOM_SERVER_HOST=chosen.example\nAD_VOICE_ROOM_SERVER_PORT='{port}'\n",
        encoding="utf-8",
    )

    assert processing_connection() == (f"https://chosen.example:{expected}/processing", _TOKEN)
