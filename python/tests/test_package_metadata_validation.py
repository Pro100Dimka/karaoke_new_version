from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from backend.version import PACKAGE_FORMAT_VERSION, PROJECT_FORMAT_VERSION


@pytest.mark.parametrize(
    "field,value",
    [
        ("duration", float("nan")),
        ("duration", float("inf")),
        ("duration", -1),
        ("duration", 10**400),
        ("revision", 2**63),
    ],
)
def test_invalid_package_numbers_are_rejected_before_catalog_changes(
    client, tmp_path: Path, field: str, value: int | float
) -> None:
    manifest = {
        "packageVersion": PACKAGE_FORMAT_VERSION,
        "projectFormatVersion": PROJECT_FORMAT_VERSION,
        "songIdentity": {
            "songId": "incoming-song",
            "sourceIdentity": "a" * 64,
            "title": "Song",
            "artist": "Artist",
            "duration": 1,
            "language": "Auto",
        },
        "revision": 1,
        "revisionFingerprint": "b" * 64,
        "lineageId": "lineage",
        "artifacts": [],
    }
    target = manifest["songIdentity"] if field == "duration" else manifest
    target[field] = value
    archive = tmp_path / "invalid.advoice.zip"
    with zipfile.ZipFile(archive, "w") as output:
        output.writestr("package.json", json.dumps(manifest))

    response = client.post("/packages/inspect", json={"path": str(archive)})

    assert response.status_code == 400, response.text
    assert response.json()["code"] == "PackageInvalid"
    assert client.get("/songs").json()["items"] == []
