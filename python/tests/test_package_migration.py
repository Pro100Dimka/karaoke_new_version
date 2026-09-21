from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path

import pytest

from backend.version import PROJECT_FORMAT_VERSION
from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.helpers import import_song, wait_for_job

pytestmark = pytest.mark.integration


def _export_ready_package(client, source: Path) -> tuple[str, Path]:
    song = import_song(client, source)
    processing = client.post(
        f"/songs/{song['songId']}/processing",
        json={"mode": "Fast", "onlineLyrics": False},
    )
    assert wait_for_job(client, processing.json()["jobId"])["state"] == "Succeeded"
    export = client.post(f"/packages/export/{song['songId']}")
    job = wait_for_job(client, export.json()["jobId"])
    assert job["state"] == "Succeeded"
    return str(song["songId"]), Path(job["report"]["path"])


def _as_previous_project_format(source: Path, target: Path) -> None:
    previous = PROJECT_FORMAT_VERSION - 1
    with zipfile.ZipFile(source, "r") as archive:
        payloads = {
            info.filename: archive.read(info.filename)
            for info in archive.infolist()
            if not info.is_dir()
        }

    project = json.loads(payloads["manifest.json"].decode("utf-8"))
    project["projectFormatVersion"] = previous
    project_bytes = json.dumps(
        project,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    payloads["manifest.json"] = project_bytes

    package = json.loads(payloads["package.json"].decode("utf-8"))
    package["projectFormatVersion"] = previous
    for artifact in package["artifacts"]:
        if artifact["path"] == "manifest.json":
            artifact["checksum"] = hashlib.sha256(project_bytes).hexdigest()
    payloads["package.json"] = json.dumps(
        package,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")

    with zipfile.ZipFile(target, "w") as archive:
        for name, payload in payloads.items():
            archive.writestr(name, payload)


def test_upgradeable_package_project_is_migrated_before_publication(tmp_path: Path) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "source", ai_providers=(FakeAiProvider(),)) as client:
        song_id, package = _export_ready_package(client, source)

    old_package = tmp_path / "project-v1.advoice.zip"
    _as_previous_project_format(package, old_package)

    target_root = tmp_path / "target"
    with app_client(target_root) as client:
        inspection = client.post("/packages/inspect", json={"path": str(old_package)})
        assert inspection.status_code == 200
        assert inspection.json()["compatibility"] == "Upgradeable"

        started = client.post(
            "/packages/import",
            json={"path": str(old_package), "decision": "SafeOnly"},
        )
        job = wait_for_job(client, started.json()["jobId"])
        assert job["state"] == "Succeeded", job
        imported = client.get(f"/songs/{song_id}").json()
        assert imported["projectFormatVersion"] == PROJECT_FORMAT_VERSION
        revision = imported["activeRevision"]

    manifest = target_root / "songs" / song_id / "revisions" / str(revision) / "manifest.json"
    stored = json.loads(manifest.read_text(encoding="utf-8"))
    assert stored["projectFormatVersion"] == PROJECT_FORMAT_VERSION
