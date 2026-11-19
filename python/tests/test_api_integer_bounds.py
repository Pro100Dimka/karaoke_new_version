from __future__ import annotations

from pathlib import Path

import pytest

from tests.conftest import app_client, write_wav
from tests.helpers import import_song


@pytest.mark.parametrize("endpoint", ["/history", "/jobs", "/recordings"])
def test_pagination_rejects_offsets_larger_than_the_database_integer_range(
    tmp_path: Path, endpoint: str
) -> None:
    with app_client(tmp_path / "runtime") as client:
        response = client.get(endpoint, params={"offset": 2**63})

        assert response.status_code == 422, response.text
        assert client.get(endpoint, params={"offset": 2**63 - 1}).status_code == 200


@pytest.mark.parametrize("operation", ["export", "editor-save"])
def test_project_commands_reject_revisions_larger_than_the_database_integer_range(
    tmp_path: Path, operation: str
) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime") as client:
        song = import_song(client, source)
        if operation == "export":
            response = client.post(f"/packages/export/{song['songId']}", params={"revision": 2**63})
        else:
            response = client.put(
                f"/songs/{song['songId']}/editor",
                json={
                    "expectedRevision": 2**63,
                    "document": {
                        "title": "Song",
                        "artist": "Artist",
                        "duration": 1.0,
                        "bpm": None,
                        "key": None,
                        "lyrics": "",
                        "words": [],
                    },
                },
            )

        assert response.status_code == 422, response.text
        assert client.get(f"/songs/{song['songId']}").json()["activeRevision"] == 1
