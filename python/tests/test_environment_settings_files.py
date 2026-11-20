from __future__ import annotations

from pathlib import Path

import pytest


@pytest.mark.parametrize(
    "key", ["AD_VOICE_ROOM_SERVER_SSH_KEY", "AD_VOICE_ROOM_SERVER_KNOWN_HOSTS"]
)
@pytest.mark.parametrize("failure", ["deleted", "denied"])
def test_unreadable_environment_file_does_not_break_the_settings_api(
    client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, key: str, failure: str
) -> None:
    selected = tmp_path / "selected-key"
    selected.write_text(
        "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----\n",
        encoding="utf-8",
    )
    original_read = Path.read_text

    def unavailable(path, *args, **kwargs):
        if path == selected:
            if failure == "denied":
                raise PermissionError("file is no longer readable")
            path.unlink(missing_ok=True)
        return original_read(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", unavailable)
    saved = client.patch(f"/settings/environment/{key}", json={"value": str(selected)})
    assert saved.status_code == 200, saved.text
    assert saved.json()["state"] == "invalid"
    assert saved.json()["configured"] is True
    assert saved.json()["value"] == str(selected)
    listed = client.get("/settings/environment")
    assert listed.status_code == 200, listed.text
    entries = {entry["key"]: entry for entry in listed.json()}
    assert entries[key]["state"] == "invalid"
    assert "AD_VOICE_AUDD_TOKEN" in entries
    corrected = client.patch(f"/settings/environment/{key}", json={"value": ""})
    assert corrected.status_code == 200
    assert corrected.json()["state"] == "empty"
