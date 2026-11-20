from __future__ import annotations

import os
from pathlib import Path

import pytest

pytestmark = pytest.mark.integration


@pytest.mark.parametrize(
    "legacy",
    ["https://rooms.example:abc", "https://rooms.example:70000", "https://[broken"],
)
def test_malformed_legacy_address_does_not_block_settings_or_local_correction(
    client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, legacy: str
) -> None:
    frontend = Path(os.environ["AD_VOICE_FRONTEND_ENV_FILE"])
    frontend.write_text(f"AD_VOICE_ROOM_SERVER='{legacy}'\nKEEP_ME=value\n", encoding="utf-8")
    monkeypatch.setenv("AD_VOICE_ENV_FILE", str(tmp_path / "python.env"))

    listed = client.get("/settings/environment")

    assert listed.status_code == 200, listed.text
    entries = {entry["key"]: entry for entry in listed.json()}
    host = entries["AD_VOICE_ROOM_SERVER_HOST"]
    assert host["state"] == "invalid"
    assert host["value"] == legacy
    saved = client.patch(
        "/settings/environment/AD_VOICE_AUDD_TOKEN", json={"value": "fixture-secret"}
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["configured"] is True
    assert saved.json()["value"] == ""

    corrected = client.patch(
        "/settings/environment/AD_VOICE_ROOM_SERVER_HOST", json={"value": "corrected.example"}
    )
    assert corrected.status_code == 200, corrected.text
    assert corrected.json()["state"] == "valid"
    port = client.patch("/settings/environment/AD_VOICE_ROOM_SERVER_PORT", json={"value": "8443"})
    assert port.status_code == 200, port.text
    reopened = client.get("/settings/environment")
    assert reopened.status_code == 200, reopened.text
    entries = {entry["key"]: entry for entry in reopened.json()}
    assert entries["AD_VOICE_ROOM_SERVER_HOST"]["value"] == "corrected.example"
    assert entries["AD_VOICE_ROOM_SERVER_PORT"]["value"] == "8443"
    assert entries["AD_VOICE_AUDD_TOKEN"]["configured"] is True
    assert "fixture-secret" not in reopened.text
    assert f"AD_VOICE_ROOM_SERVER='{legacy}'" in frontend.read_text(encoding="utf-8")
    assert "KEEP_ME=value" in frontend.read_text(encoding="utf-8")


def test_explicit_host_and_port_win_even_when_unused_legacy_url_is_malformed(client) -> None:
    frontend = Path(os.environ["AD_VOICE_FRONTEND_ENV_FILE"])
    frontend.write_text(
        "AD_VOICE_ROOM_SERVER='https://rooms.example:bad'\n"
        "AD_VOICE_ROOM_SERVER_HOST=chosen.example\nAD_VOICE_ROOM_SERVER_PORT=8443\n",
        encoding="utf-8",
    )

    listed = client.get("/settings/environment")

    assert listed.status_code == 200, listed.text
    entries = {entry["key"]: entry for entry in listed.json()}
    assert entries["AD_VOICE_ROOM_SERVER_HOST"]["value"] == "chosen.example"
    assert entries["AD_VOICE_ROOM_SERVER_HOST"]["state"] == "valid"
    assert entries["AD_VOICE_ROOM_SERVER_PORT"]["value"] == "8443"
    assert entries["AD_VOICE_ROOM_SERVER_PORT"]["state"] == "valid"


@pytest.mark.parametrize(
    ("legacy", "host", "port"),
    [
        ("http://rooms.example:8181", "rooms.example", "8181"),
        ("https://rooms.example", "rooms.example", "443"),
    ],
)
def test_valid_legacy_addresses_keep_existing_settings_fallback(client, legacy, host, port) -> None:
    Path(os.environ["AD_VOICE_FRONTEND_ENV_FILE"]).write_text(
        f"AD_VOICE_ROOM_SERVER='{legacy}'\n", encoding="utf-8"
    )

    listed = client.get("/settings/environment")

    assert listed.status_code == 200, listed.text
    entries = {entry["key"]: entry for entry in listed.json()}
    assert entries["AD_VOICE_ROOM_SERVER_HOST"]["value"] == host
    assert entries["AD_VOICE_ROOM_SERVER_PORT"]["value"] == port
