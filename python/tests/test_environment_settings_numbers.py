from __future__ import annotations

import os
from pathlib import Path

import pytest


@pytest.mark.parametrize(
    "key",
    [
        "AD_VOICE_ROOM_SERVER_PORT",
        "AD_VOICE_ROOM_SERVER_RELAY_PORT",
        "AD_VOICE_ROOM_SERVER_SSH_USER",
    ],
)
def test_unicode_digit_input_is_reported_invalid_without_breaking_settings(
    client, key: str
) -> None:
    saved = client.patch(f"/settings/environment/{key}", json={"value": "²"})

    assert saved.status_code == 200, saved.text
    assert saved.json()["state"] == "invalid"
    listed = client.get("/settings/environment")
    assert listed.status_code == 200, listed.text
    entry = next(item for item in listed.json() if item["key"] == key)
    assert entry["state"] == "invalid"
    assert entry["value"] == "²"


@pytest.mark.parametrize("value", ["²", "9" * 5000], ids=["non_decimal_digit", "oversized_integer"])
def test_invalid_saved_port_does_not_prevent_reading_environment_settings(
    client, value: str
) -> None:
    path = Path(os.environ["AD_VOICE_FRONTEND_ENV_FILE"])
    path.write_text(f"AD_VOICE_ROOM_SERVER_PORT={value}\n", encoding="utf-8")

    listed = client.get("/settings/environment")

    assert listed.status_code == 200, listed.text
    entry = next(item for item in listed.json() if item["key"] == "AD_VOICE_ROOM_SERVER_PORT")
    assert entry["state"] == "invalid"
    assert entry["value"] == value


@pytest.mark.parametrize("value", ["00080", "٨٠"])
def test_port_validation_keeps_supported_decimal_spellings(client, value: str) -> None:
    saved = client.patch("/settings/environment/AD_VOICE_ROOM_SERVER_PORT", json={"value": value})

    assert saved.status_code == 200, saved.text
    assert saved.json()["state"] == "valid"
    assert saved.json()["value"] == value
