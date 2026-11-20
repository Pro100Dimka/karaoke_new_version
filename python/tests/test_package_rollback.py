from __future__ import annotations

from pathlib import Path

import pytest

from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.helpers import wait_for_job
from tests.test_packages_e2e import make_ready_and_export

pytestmark = pytest.mark.integration


def test_known_older_package_requires_a_choice_before_hiding_manual_changes(tmp_path: Path) -> None:
    source, root = tmp_path / "song.wav", tmp_path / "runtime"
    write_wav(source)
    with app_client(root, ai_providers=(FakeAiProvider(),)) as client:
        song, package = make_ready_and_export(client, source)
        song_id = str(song["songId"])
        endpoint = f"/songs/{song_id}/editor"
        before = client.get(endpoint).json()
        before["document"]["words"][0]["notes"][0]["note"] = 81
        saved = client.put(
            endpoint, json={"expectedRevision": before["revision"], "document": before["document"]}
        )
        assert saved.status_code == 200, saved.text
        newer_revision = saved.json()["revision"]
        revisions = root / "songs" / song_id / "revisions"
        newer_guide = revisions / str(newer_revision) / "audio/melody.flac"
        newer_bytes = newer_guide.read_bytes()
        revision_names = sorted(path.name for path in revisions.iterdir())

        imported = client.post(
            "/packages/import", json={"path": str(package), "decision": "SafeOnly"}
        )
        rejected = wait_for_job(client, imported.json()["jobId"])
        assert rejected["state"] == "Failed", rejected
        assert rejected["error"]["code"] == "PackageConflict"
        assert (
            client.post("/packages/inspect", json={"path": str(package)}).json()["conflict"]
            == "OlderRevision"
        )
        assert client.get(endpoint).json()["revision"] == newer_revision
        assert client.get(endpoint).json()["document"]["words"][0]["notes"][0]["note"] == 81

        approved = client.post(
            "/packages/import", json={"path": str(package), "decision": "AcceptOlder"}
        )
        completed = wait_for_job(client, approved.json()["jobId"])
        assert completed["state"] == "Succeeded", completed
        reopened = client.get(endpoint).json()
        assert reopened["revision"] == before["revision"]
        assert reopened["document"]["words"][0]["notes"][0]["note"] == 69
        assert newer_guide.read_bytes() == newer_bytes
        assert sorted(path.name for path in revisions.iterdir()) == revision_names
