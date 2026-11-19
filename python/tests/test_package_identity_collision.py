from __future__ import annotations

import hashlib
import json
import zipfile
from dataclasses import replace
from pathlib import Path

import pytest

from backend.projects.fingerprint import manifest_fingerprint
from backend.projects.manifest_codec import decode_manifest, encode_manifest
from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.helpers import import_song, wait_for_job
from tests.test_packages_e2e import make_ready_and_export


@pytest.mark.parametrize("decision", ["SafeOnly", "AcceptOlder", "AcceptDivergent"])
def test_package_cannot_replace_a_different_song_with_the_same_identifier(
    tmp_path: Path, decision: str
) -> None:
    incoming_source = tmp_path / "incoming.wav"
    local_source = tmp_path / "local.wav"
    write_wav(incoming_source, frequency=440)
    write_wav(local_source, frequency=880)
    with app_client(tmp_path / "sender", ai_providers=(FakeAiProvider(),)) as sender:
        _, incoming_package = make_ready_and_export(sender, incoming_source)

    with app_client(tmp_path / "recipient") as recipient:
        local_song = import_song(recipient, local_source, title="Keep my song")
        song_id = str(local_song["songId"])
        package = tmp_path / "colliding-package.zip"
        with zipfile.ZipFile(incoming_package) as source, zipfile.ZipFile(package, "w") as output:
            project = replace(
                decode_manifest(source.read("manifest.json").decode("utf-8")), song_id=song_id
            )
            project_bytes = encode_manifest(project).encode("utf-8")
            manifest = json.loads(source.read("package.json"))
            manifest["songIdentity"]["songId"] = song_id
            manifest["revisionFingerprint"] = manifest_fingerprint(project)
            for artifact in manifest["artifacts"]:
                if artifact["path"] == "manifest.json":
                    artifact["checksum"] = hashlib.sha256(project_bytes).hexdigest()
            replacements = {
                "manifest.json": project_bytes,
                "package.json": json.dumps(manifest).encode("utf-8"),
            }
            for entry in source.infolist():
                output.writestr(
                    entry.filename, replacements.get(entry.filename, source.read(entry))
                )

        inspected = recipient.post("/packages/inspect", json={"path": str(package)})
        imported = recipient.post(
            "/packages/import", json={"path": str(package), "decision": decision}
        )
        if imported.status_code == 202:
            result = wait_for_job(recipient, imported.json()["jobId"])
        else:
            result = imported.json()

        assert inspected.status_code == 409, (inspected.json(), result)
        assert inspected.json()["code"] == "PackageConflict"
        assert imported.status_code == 409, result
        current = recipient.get(f"/songs/{song_id}").json()
        assert current["title"] == "Keep my song"
        assert current["activeRevision"] == local_song["activeRevision"]
        assert current["status"] == local_song["status"]
        assert Path(current["sourcePath"]).read_bytes() == local_source.read_bytes()
