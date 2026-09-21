from __future__ import annotations

import pytest
import hashlib
import shutil
from pathlib import Path

from sqlalchemy import event

from backend.ai.domain import RequiredModel
from backend.projects.manifest_codec import decode_manifest
from backend.songs.queries import ListSongsQuery
from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.helpers import import_song, wait_for_job


pytestmark = pytest.mark.integration


def _process(client, source: Path) -> tuple[str, int]:
    song = import_song(client, source)
    response = client.post(
        f"/songs/{song['songId']}/processing",
        json={"mode": "Fast", "onlineLyrics": False},
    )
    job = wait_for_job(client, response.json()["jobId"])
    assert job["state"] == "Succeeded", job
    current = client.get(f"/songs/{song['songId']}").json()
    return str(current["songId"]), int(current["activeRevision"])


def test_deleting_processing_cache_does_not_damage_canonical_project(tmp_path: Path) -> None:
    root = tmp_path / "runtime"
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(root, ai_providers=(FakeAiProvider(),)) as client:
        song_id, revision = _process(client, source)
        assert client.get(f"/songs/{song_id}/editor").status_code == 200

    shutil.rmtree(root / "cache", ignore_errors=True)

    with app_client(root) as client:
        song = client.get(f"/songs/{song_id}")
        editor = client.get(f"/songs/{song_id}/editor")
        assert song.status_code == 200
        assert song.json()["activeRevision"] == revision
        assert song.json()["status"] == "Ready"
        assert editor.status_code == 200


def test_song_list_query_count_is_constant(client, tmp_path: Path) -> None:
    for index in range(12):
        source = tmp_path / f"song-{index}.wav"
        write_wav(source, frequency=400 + index * 10)
        import_song(client, source, title=f"Song {index:02}")

    engine = client.app.state.container.database.engine
    statements: list[str] = []

    def count_selects(_connection, _cursor, statement, _parameters, _context, _many) -> None:
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    event.listen(engine, "before_cursor_execute", count_selects)
    try:
        page = client.app.state.container.songs.list_songs.execute(ListSongsQuery(limit=10))
    finally:
        event.remove(engine, "before_cursor_execute", count_selects)

    assert len(page.items) == 10
    assert len(statements) == 2


def test_processing_manifest_records_reproducible_provider_and_model_identity(
    tmp_path: Path,
) -> None:
    model_bytes = b"model-contract" * 32
    checksum = hashlib.sha256(model_bytes).hexdigest()
    requirement = RequiredModel("shared-model", "7", checksum)
    provider = FakeAiProvider(required_models=(requirement,))
    root = tmp_path / "runtime"
    source_model = tmp_path / "model.bin"
    source_model.write_bytes(model_bytes)
    source_audio = tmp_path / "song.wav"
    write_wav(source_audio)

    with app_client(root, ai_providers=(provider,)) as client:
        declaration = client.put(
            "/models/shared-model/7",
            json={
                "modelId": "shared-model",
                "purpose": "ASR",
                "version": "7",
                "size": len(model_bytes),
                "checksum": checksum,
                "downloadUrl": source_model.resolve().as_uri(),
                "selected": False,
            },
        )
        assert declaration.status_code == 200
        download = client.post("/models/shared-model/7/download")
        assert wait_for_job(client, download.json()["jobId"])["state"] == "Succeeded"
        song_id, revision = _process(client, source_audio)

    manifest_path = root / "songs" / song_id / "revisions" / str(revision) / "manifest.json"
    manifest = decode_manifest(manifest_path.read_text(encoding="utf-8"))
    assert manifest.provenance["algorithmVersion"] == "pipeline-1"
    providers = manifest.provenance["providers"]
    assert isinstance(providers, dict)
    for details in providers.values():
        assert isinstance(details, dict)
        assert details["providerId"] == "fake-ai"
        assert details["providerVersion"] == "1"
        assert details["models"] == [
            {
                "modelId": "shared-model",
                "modelVersion": "7",
                "modelChecksum": checksum,
            }
        ]
