from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from pathlib import Path

import pytest

from backend.lyrics.codec import decode_document, encode_document
from backend.lyrics.domain import LyricsDocument, Word
from backend.projects.domain import ArtifactCategory, ProjectArtifact, ProjectRevision
from backend.projects.fingerprint import manifest_fingerprint
from backend.projects.manifest_codec import encode_manifest
from backend.songs.domain import SongStatus
from tests.conftest import write_wav
from tests.helpers import import_song

pytestmark = pytest.mark.integration


def _publish_document_fixture(client, song_id: str, source: Path) -> None:
    container = client.app.state.container
    song = container.songs.get_song.execute(song_id)
    projects = container.songs.save_editor._projects
    # These are the document constructor inputs used by DocumentPipeline._construct.
    # Author only the tiny persistence fixture; do not run processing, alignment or DSP.
    document = LyricsDocument(
        song.title, song.artist, song.duration, None, None, "la", (Word("la", 0, 0.1, ()),)
    )
    raw = encode_document(document)
    files = {Path(name + ".wav"): source for name in ("instrumental", "referenceVocal")}
    texts = {Path(name + ".json"): raw for name in ("lyricsSync", "lyricsBaseline")}
    base = projects.load_manifest(song_id, song.active_revision)
    artifacts = [
        ProjectArtifact(
            relative.stem,
            relative,
            ArtifactCategory.PORTABLE,
            hashlib.sha256(source.read_bytes()).hexdigest(),
        )
        for relative in files
    ] + [
        ProjectArtifact(
            relative.stem,
            relative,
            ArtifactCategory.PORTABLE,
            hashlib.sha256(raw.encode("utf-8")).hexdigest(),
        )
        for relative in texts
    ]
    manifest = replace(base, revision=2, artifacts=(*base.artifacts, *artifacts))
    working = projects.stage_revision(
        song_id,
        2,
        files,
        {**texts, Path("manifest.json"): encode_manifest(manifest)},
        base_revision=song.active_revision,
    )
    projects.publish_revision(song_id, 2, working)
    with container.database.create() as transaction:
        previous = transaction.projects.get(song_id, song.active_revision)
        transaction.projects.add(
            ProjectRevision(
                song_id,
                2,
                manifest_fingerprint(manifest),
                song.project_format_version,
                previous.lineage_id,
                song.updated_at,
            )
        )
        transaction.songs.update(replace(song, status=SongStatus.READY, active_revision=2))
        transaction.commit()


def test_cleared_song_artist_survives_document_storage_editor_save_and_reset(
    client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "song.wav"
    write_wav(source, seconds=0.125)
    original = source.read_bytes()
    song = import_song(client, source, title="Song", artist="Singer")
    song_id = song["songId"]

    cleared = client.patch(f"/songs/{song_id}", json={"artist": ""})

    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["artist"] == ""
    _publish_document_fixture(client, song_id, source)
    endpoint = f"/songs/{song_id}/editor"
    opened = client.get(endpoint)
    assert opened.status_code == 200, opened.text
    editor = opened.json()
    assert editor["document"]["artist"] == ""

    def forbid_render(*_args, **_kwargs):
        pytest.fail("A text-only persistence check must not render audio")

    monkeypatch.setattr(
        client.app.state.container.songs.save_editor._melody._renderer, "run", forbid_render
    )
    edited = {**editor["document"], "lyrics": "la again"}
    saved = client.put(endpoint, json={"expectedRevision": editor["revision"], "document": edited})
    assert saved.status_code == 200, saved.text
    reopened = client.get(endpoint).json()
    assert reopened["revision"] == saved.json()["revision"]
    assert reopened["document"] == edited

    reset = client.post(f"{endpoint}/reset", json={"expectedRevision": reopened["revision"]})
    assert reset.status_code == 200, reset.text
    restored = client.get(endpoint).json()
    assert restored["revision"] == reset.json()["revision"]
    assert restored["document"] == editor["document"]
    assert client.get(f"/songs/{song_id}").json()["artist"] == ""
    assert source.read_bytes() == original


@pytest.mark.parametrize("invalid", [None, 42, False])
def test_document_artist_still_requires_text(invalid) -> None:
    document = LyricsDocument("Song", "Singer", 1, None, None, "la", (Word("la", 0, 0.5, ()),))
    payload = json.loads(encode_document(document))
    payload["artist"] = invalid

    with pytest.raises(ValueError, match="artist must be text"):
        decode_document(json.dumps(payload))


@pytest.mark.parametrize("field", ["title", "word"])
def test_optional_artist_does_not_relax_required_document_text(field: str) -> None:
    document = LyricsDocument("Song", "Singer", 1, None, None, "la", (Word("la", 0, 0.5, ()),))
    payload = json.loads(encode_document(document))
    if field == "title":
        payload["title"] = ""
    else:
        payload["words"][0]["text"] = ""

    with pytest.raises(ValueError, match="must be text"):
        decode_document(json.dumps(payload))
