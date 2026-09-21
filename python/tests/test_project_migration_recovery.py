from __future__ import annotations

from pathlib import Path

import pytest

from backend.domain_errors import DependencyError
from backend.infrastructure.database import SqlUnitOfWork
from backend.serialization import dumps, loads_object
from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.helpers import import_song, wait_for_job


pytestmark = pytest.mark.integration


def _ready_song(client, tmp_path: Path) -> dict[str, object]:
    source = tmp_path / "ready.wav"
    write_wav(source)
    song = import_song(client, source)
    response = client.post(
        f"/songs/{song['songId']}/processing",
        json={"mode": "Fast", "onlineLyrics": False},
    )
    assert response.status_code == 202, response.text
    assert wait_for_job(client, response.json()["jobId"])["state"] == "Succeeded"
    return client.get(f"/songs/{song['songId']}").json()


def test_upgradeable_project_migration_preserves_backup_and_publishes_new_revision(
    tmp_path: Path,
) -> None:
    root = tmp_path / "runtime"
    with app_client(root, ai_providers=(FakeAiProvider(),)) as client:
        song = _ready_song(client, tmp_path)
        song_id = str(song["songId"])
        revision = int(song["activeRevision"])
        manifest_path = root / "songs" / song_id / "revisions" / str(revision) / "manifest.json"
        manifest = loads_object(manifest_path.read_text(encoding="utf-8"))
        manifest["projectFormatVersion"] = 1
        manifest_path.write_text(dumps(manifest), encoding="utf-8")

        compatibility = client.get(
            f"/songs/{song_id}/project/compatibility",
            params={"revision": revision},
        )
        migrated = client.post(f"/songs/{song_id}/project/migrate")

        assert compatibility.status_code == 200
        assert compatibility.json()["compatibility"] == "Upgradeable"
        assert migrated.status_code == 200, migrated.text
        assert migrated.json()["revision"] == revision + 1
        assert (root / "backups" / f"revision-{revision}").is_dir()
        current = client.get(f"/songs/{song_id}").json()
        assert current["activeRevision"] == revision + 1
        assert current["projectFormatVersion"] == 2


def test_reconciliation_marks_corrupt_ready_project_without_guessing_repair(tmp_path: Path) -> None:
    root = tmp_path / "runtime"
    with app_client(root, ai_providers=(FakeAiProvider(),)) as client:
        song = _ready_song(client, tmp_path)
        song_id = str(song["songId"])
        revision = int(song["activeRevision"])
        instrumental = (
            root / "songs" / song_id / "revisions" / str(revision) / "audio" / "instrumental.wav"
        )
        instrumental.write_bytes(b"corrupted")

        response = client.post("/recovery/reconcile")
        assert response.status_code == 202, response.text
        job = wait_for_job(client, response.json()["jobId"])

        assert job["state"] == "Succeeded"
        issues = job["report"]["issues"]
        issue = next(item for item in issues if item["entityId"] == song_id)
        assert issue["code"] == "CorruptArtifact"
        assert issue["action"] == "ReprocessRequired"
        assert client.get(f"/songs/{song_id}").json()["status"] == "ProjectInvalid"
        assert instrumental.read_bytes() == b"corrupted"


def test_reconciliation_marks_missing_managed_source(tmp_path: Path) -> None:
    root = tmp_path / "runtime"
    source = tmp_path / "source.wav"
    write_wav(source)
    with app_client(root) as client:
        song = import_song(client, source)
        song_id = str(song["songId"])
        managed = next((root / "songs" / song_id / "source").glob("original.*"))
        managed.unlink()

        response = client.post("/recovery/reconcile")
        job = wait_for_job(client, response.json()["jobId"])

        assert job["state"] == "Succeeded"
        issue = next(item for item in job["report"]["issues"] if item["entityId"] == song_id)
        assert issue["code"] == "SourceMissing"
        assert issue["action"] == "ManualActionRequired"
        assert client.get(f"/songs/{song_id}").json()["status"] == "SourceMissing"


def test_reconciliation_reports_orphan_project_without_auto_repair(tmp_path: Path) -> None:
    root = tmp_path / "runtime"
    with app_client(root) as client:
        orphan_revision = root / "songs" / "orphan-song" / "revisions" / "1"
        orphan_revision.mkdir(parents=True)
        (orphan_revision / "manifest.json").write_text("{}", encoding="utf-8")

        response = client.post("/recovery/reconcile")
        job = wait_for_job(client, response.json()["jobId"])

        assert job["state"] == "Succeeded"
        issue = next(item for item in job["report"]["issues"] if item["entityId"] == "orphan-song")
        assert issue["code"] == "OrphanProject"
        assert issue["action"] == "ManualActionRequired"
        assert orphan_revision.is_dir()


def test_project_migration_commit_failure_preserves_original_revision(
    tmp_path: Path,
    monkeypatch,
) -> None:

    root = tmp_path / "runtime"
    with app_client(root, ai_providers=(FakeAiProvider(),)) as client:
        song = _ready_song(client, tmp_path)
        song_id = str(song["songId"])
        revision = int(song["activeRevision"])
        manifest_path = root / "songs" / song_id / "revisions" / str(revision) / "manifest.json"
        original = loads_object(manifest_path.read_text(encoding="utf-8"))
        previous = dict(original)
        previous["projectFormatVersion"] = 1
        manifest_path.write_text(dumps(previous), encoding="utf-8")

        original_commit = SqlUnitOfWork.commit

        def fail_commit(self: SqlUnitOfWork) -> None:
            raise DependencyError("DatabaseWriteFailed", "injected migration commit failure")

        monkeypatch.setattr(SqlUnitOfWork, "commit", fail_commit)
        with pytest.raises(DependencyError):
            client.app.state.container.songs.migrate_project.execute(song_id)
        monkeypatch.setattr(SqlUnitOfWork, "commit", original_commit)

        current = client.get(f"/songs/{song_id}").json()
        assert current["activeRevision"] == revision
        stored = loads_object(manifest_path.read_text(encoding="utf-8"))
        assert stored["projectFormatVersion"] == 1

    with app_client(root) as client:
        current = client.get(f"/songs/{song_id}").json()
        assert current["activeRevision"] == revision
        assert client.app.state.container.startup_recovery.recovered_transactions >= 1

    assert not (root / "songs" / song_id / "revisions" / str(revision + 1)).exists()
