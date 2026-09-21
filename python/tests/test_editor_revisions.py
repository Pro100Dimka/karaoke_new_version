from __future__ import annotations

import pytest
from pathlib import Path

from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.helpers import import_song, wait_for_job


pytestmark = pytest.mark.integration


def ready_song(client, source: Path) -> dict[str, object]:
    song = import_song(client, source)
    response = client.post(
        f"/songs/{song['songId']}/processing",
        json={"mode": "Fast", "onlineLyrics": False},
    )
    assert response.status_code == 202, response.text
    job = wait_for_job(client, response.json()["jobId"])
    assert job["state"] == "Succeeded", job
    return client.get(f"/songs/{song['songId']}").json()


def test_editor_save_requires_expected_revision(tmp_path: Path) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song = ready_song(client, source)
        opened = client.get(f"/songs/{song['songId']}/editor")
        assert opened.status_code == 200, opened.text
        editor = opened.json()
        document = editor["document"]
        document["words"][0]["notes"][0]["note"] = 70

        saved = client.put(
            f"/songs/{song['songId']}/editor",
            json={"expectedRevision": editor["revision"], "document": document},
        )
        assert saved.status_code == 200, saved.text
        assert saved.json()["revision"] == editor["revision"] + 1

        stale = client.put(
            f"/songs/{song['songId']}/editor",
            json={"expectedRevision": editor["revision"], "document": document},
        )
        assert stale.status_code == 409
        assert stale.json()["code"] == "RevisionConflict"


def test_editor_reset_restores_ai_baseline_as_new_revision(tmp_path: Path) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song = ready_song(client, source)
        opened = client.get(f"/songs/{song['songId']}/editor").json()
        original_note = opened["document"]["words"][0]["notes"][0]["note"]
        changed = opened["document"]
        changed["words"][0]["notes"][0]["note"] = original_note + 5
        saved = client.put(
            f"/songs/{song['songId']}/editor",
            json={"expectedRevision": opened["revision"], "document": changed},
        ).json()

        reset = client.post(
            f"/songs/{song['songId']}/editor/reset",
            json={"expectedRevision": saved["revision"]},
        )
        assert reset.status_code == 200, reset.text
        current = client.get(f"/songs/{song['songId']}/editor").json()

        assert current["revision"] == saved["revision"] + 1
        assert current["document"]["words"][0]["notes"][0]["note"] == original_note
