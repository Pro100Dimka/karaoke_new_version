from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from pathlib import Path

import pytest

from backend.editor import save_document
from tests.conftest import write_wav
from tests.helpers import import_song
from tests.test_editor_empty_artist import _publish_document_fixture

pytestmark = pytest.mark.integration


@pytest.fixture
def editor(client, tmp_path: Path):
    source = tmp_path / "song.wav"
    write_wav(source, seconds=0.125)
    song_id = import_song(client, source, title="Song", artist="Singer")["songId"]
    _publish_document_fixture(client, song_id, source)
    return (
        song_id,
        f"/songs/{song_id}/editor",
        client.app.state.container.songs.save_editor._projects,
    )


def _fingerprint(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def test_editor_fingerprint_follows_actual_lyrics_when_revision_metadata_is_stale(client, editor):
    song_id, endpoint, projects = editor
    opened = client.get(endpoint)
    assert opened.status_code == 200, opened.text
    before = opened.json()
    revision = before["revision"]
    raw = projects.read_text_artifact(song_id, revision, "lyricsSync")
    assert before["documentFingerprint"] == _fingerprint(raw)
    manifest = projects.load_manifest(song_id, revision)
    with client.app.state.container.database.create() as transaction:
        metadata = transaction.projects.get(song_id, revision)

    replacement = json.loads(raw)
    replacement["lyrics"] = "Замінений текст"
    replacement["vocalActivity"] = [[0, 0.1]]
    replacement["rhythm"] = [[0.05, 0.7]]
    replaced_raw = json.dumps(replacement, ensure_ascii=False, indent=2)
    projects.artifact_path(song_id, revision, "lyricsSync").write_text(
        replaced_raw, encoding="utf-8"
    )
    reopened = client.get(endpoint)
    assert reopened.status_code == 200, reopened.text
    after = reopened.json()
    assert after["songId"] == before["songId"]
    assert after["revision"] == revision
    assert after["documentFingerprint"] == _fingerprint(replaced_raw)
    assert after["documentFingerprint"] != before["documentFingerprint"]
    assert after["document"]["rhythm"] == [[0.05, 0.7]]
    assert projects.load_manifest(song_id, revision) == manifest
    with client.app.state.container.database.create() as transaction:
        assert transaction.projects.get(song_id, revision) == metadata


def test_saved_fingerprint_matches_next_get_and_encodes_document_once(client, editor, monkeypatch):
    song_id, endpoint, projects = editor
    before = client.get(endpoint).json()
    document = {**before["document"], "lyrics": "Saved lyrics"}
    encoded = []
    original = save_document.encode_document

    def counted(value):
        result = original(value)
        encoded.append(result)
        return result

    monkeypatch.setattr(save_document, "encode_document", counted)
    response = client.put(
        endpoint, json={"expectedRevision": before["revision"], "document": document}
    )
    assert response.status_code == 200, response.text
    saved = response.json()
    reopened = client.get(endpoint).json()
    raw = projects.read_text_artifact(song_id, saved["revision"], "lyricsSync")
    assert saved["documentFingerprint"] == reopened["documentFingerprint"] == _fingerprint(raw)
    assert saved["documentFingerprint"] != before["documentFingerprint"]
    assert len(encoded) == 1
    assert encoded == [raw]


def test_legacy_save_and_reset_keep_integer_revision_contracts(client, editor):
    song_id, endpoint, _projects = editor
    cases = client.app.state.container.songs
    opened = cases.get_editor.execute(song_id)
    saved = cases.save_editor.execute(
        song_id, opened.revision, replace(opened.document, lyrics="Legacy caller")
    )
    assert type(saved) is int
    assert saved > opened.revision
    reset = client.post(f"{endpoint}/reset", json={"expectedRevision": saved})
    assert reset.status_code == 200, reset.text
    assert reset.json() == {"revision": saved + 1}
    migrated = client.post(f"/songs/{song_id}/project/migrate")
    assert migrated.status_code == 200, migrated.text
    assert migrated.json() == reset.json()
