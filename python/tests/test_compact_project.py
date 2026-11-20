from __future__ import annotations

import json
import threading
from pathlib import Path

import numpy as np
import soundfile as sf

from backend.infrastructure.lossless_audio import compress_audio
from backend.infrastructure.process_runner import ProcessRunner
from backend.lyrics.codec import encode_document
from backend.lyrics.domain import LyricsDocument, Note, Word
from tests.conftest import app_client, write_wav
from tests.helpers import import_song


def _inputs(directory: Path):
    source = directory / "original.wav"
    write_wav(source, seconds=2, sample_rate=44100)
    time = np.arange(88200) / 44100
    samples = 0.1 * np.column_stack(
        (np.sin(2 * np.pi * 440 * time), np.sin(2 * np.pi * 550 * time))
    )
    paths = [directory / name for name in ("backing.wav", "voice.wav", "melody.wav")]
    for path in paths:
        sf.write(path, samples, 44100, subtype="PCM_24" if path != paths[-1] else "PCM_16")
    lyrics = LyricsDocument(
        "Title", "Artist", 2, 120, "A", "la", (Word("la", 0.2, 1.2, (Note(69, 0.3, 1.1),)),)
    )
    return source, paths, lyrics


def test_generated_project_compacts_only_playback_and_keeps_original_notes_and_melody(tmp_path):
    source, inputs, lyrics = _inputs(tmp_path)
    before = [path.read_bytes() for path in [source, *inputs]]
    with app_client(tmp_path / "runtime") as client:
        song = import_song(client, source)
        publisher = client.app.state.container.songs.start_processing._pipeline._publisher
        revision = publisher.publish_generated(
            song["songId"], 1, *inputs, lyrics, {"playbackPeakDbfs": -18}, "lineage"
        )
        storage = publisher._storage
        manifest = storage.load_manifest(song["songId"], revision)
        paths = {item.logical_name: item.relative_path for item in manifest.artifacts}
        assert paths["instrumental"] == Path("audio/instrumental.mp3")
        assert paths["referenceVocal"] == Path("audio/reference-vocal.mp3")
        assert paths["instrumentalPeaks"] == Path("audio/instrumental.mp3.peaks.json")
        assert paths["melody"] == Path("audio/melody.flac")
        assert storage.read_text_artifact(
            song["songId"], revision, "lyricsSync"
        ) == encode_document(lyrics)
        assert storage.read_text_artifact(
            song["songId"], revision, "lyricsBaseline"
        ) == encode_document(lyrics)
        rendered = storage.artifact_path(song["songId"], revision, "melody")
        np.testing.assert_array_equal(
            sf.read(rendered, dtype="int32")[0], sf.read(inputs[-1], dtype="int32")[0]
        )
        publisher._validator.validate(song["songId"], revision, require_ready=True)
    assert [path.read_bytes() for path in [source, *inputs]] == before


def test_regeneration_prunes_superseded_files_only_in_the_new_revision(tmp_path, monkeypatch):
    from backend.projects import publisher as publisher_module

    source, inputs, lyrics = _inputs(tmp_path)

    def legacy_stems(instrumental, vocal, workspace):
        return tuple(
            compress_audio(path, ProcessRunner(), threading.Event())
            for path in (instrumental, vocal)
        )

    with app_client(tmp_path / "runtime") as client:
        song = import_song(client, source)
        publisher = client.app.state.container.songs.start_processing._pipeline._publisher
        with monkeypatch.context() as legacy:
            legacy.setattr(publisher_module, "compact_stems", legacy_stems, raising=False)
            old_revision = publisher.publish_generated(
                song["songId"], 1, *inputs, lyrics, {}, "lineage"
            )
        old_root = tmp_path / "runtime" / "songs" / song["songId"] / "revisions" / str(old_revision)
        old_files = {
            path.relative_to(old_root): path.read_bytes()
            for path in old_root.rglob("*")
            if path.is_file()
        }
        revision = publisher.publish_generated(
            song["songId"], old_revision, *inputs, lyrics, {}, "lineage"
        )
        new_root = old_root.parent / str(revision)
        assert (new_root / "audio" / "instrumental.mp3").is_file()
        assert not (new_root / "audio" / "instrumental.flac").exists()
        assert not (new_root / "audio" / "reference-vocal.flac").exists()
        assert not (new_root / "audio" / "instrumental.flac.peaks.json").exists()
        assert {
            path.relative_to(old_root): path.read_bytes()
            for path in old_root.rglob("*")
            if path.is_file()
        } == old_files


def test_republishing_compact_stems_keeps_bytes_and_shares_unchanged_audio(tmp_path):
    source, inputs, lyrics = _inputs(tmp_path)
    with app_client(tmp_path / "runtime") as client:
        song = import_song(client, source)
        publisher = client.app.state.container.songs.start_processing._pipeline._publisher
        first = publisher.publish_generated(song["songId"], 1, *inputs, lyrics, {}, "lineage")
        storage = publisher._storage
        original_stems = tuple(
            storage.artifact_path(song["songId"], first, name)
            for name in ("instrumental", "referenceVocal")
        )
        old_root = original_stems[0].parent.parent
        before = {str(path): path.read_bytes() for path in old_root.rglob("*") if path.is_file()}
        second = publisher.publish_generated(
            song["songId"], first, *original_stems, inputs[-1], lyrics, {}, "lineage"
        )
        for logical, old in zip(("instrumental", "referenceVocal"), original_stems, strict=True):
            new = storage.artifact_path(song["songId"], second, logical)
            assert new.read_bytes() == old.read_bytes()
            assert new.samefile(old), "Unchanged stems must remain shared between revisions"
        assert {
            str(path): path.read_bytes() for path in old_root.rglob("*") if path.is_file()
        } == before
        manifest = storage.load_manifest(song["songId"], second)
        new_root = storage.artifact_path(song["songId"], second, "instrumental").parent.parent
        listed = {item.relative_path for item in manifest.artifacts}
        assert {
            path.relative_to(new_root) for path in (new_root / "audio").rglob("*") if path.is_file()
        }.issubset(listed)
        peaks = json.loads(storage.read_text_artifact(song["songId"], second, "instrumentalPeaks"))
        assert peaks["size"] == original_stems[0].stat().st_size
