from __future__ import annotations

import pytest
from backend.version import API_VERSION, BACKEND_VERSION


pytestmark = pytest.mark.integration


def test_health_and_version_contract(client) -> None:
    live = client.get("/health/live")
    ready = client.get("/health/ready")
    version = client.get("/version")

    assert live.status_code == 200
    assert live.json()["ok"] is True
    assert ready.status_code == 200
    assert ready.json()["ok"] is True
    assert version.json() == {"backendVersion": BACKEND_VERSION, "apiVersion": API_VERSION}


def test_api_version_mismatch_is_explicit(client) -> None:
    response = client.get("/health/live", headers={"X-API-Version": "999"})

    assert response.status_code == 409
    assert response.json()["code"] == "ApiVersionMismatch"
    assert response.json()["details"] == {"expected": API_VERSION, "received": "999"}


def test_request_identity_headers_are_returned(client) -> None:
    response = client.get("/health/live", headers={"X-Request-ID": "request-123"})

    assert response.headers["x-request-id"] == "request-123"
    assert response.headers["x-api-version"] == str(API_VERSION)


def test_capabilities_use_public_camel_case_contract(client) -> None:
    response = client.get("/capabilities")

    assert response.status_code == 200
    payload = response.json()
    assert "canImportSongs" in payload
    assert "canProcessSongs" in payload
    assert "can_import_songs" not in payload


def test_missing_optional_ai_keeps_unrelated_capabilities_available(client) -> None:
    payload = client.get("/capabilities").json()

    assert payload["canImportSongs"] is True
    assert payload["canProcessSongs"] is False
    assert payload["canAnalyzeRecording"] is True
    assert payload["packageImportAvailable"] is True
    assert payload["packageExportAvailable"] is True
