from __future__ import annotations

import numpy as np
import pytest
import soundfile as sf

from backend.infrastructure import project_audio
from backend.infrastructure.hashing import sha256_file
from backend.lyrics.domain import LyricsDocument, Note, Word
from tests.conftest import app_client
from tests.fakes import FakeAiProvider
from tests.helpers import import_song, wait_for_job


@pytest.mark.parametrize("operation", ["melody", "lyrics"])
@pytest.mark.parametrize("prepared_headroom", [False, True])
def test_reprocessing_compact_audio_reuses_prepared_stems_and_handles_legacy_levels(
    tmp_path, monkeypatch, operation, prepared_headroom
):
    rate = 44100
    ceiling = 10 ** (-18 / 20)
    time = np.arange(rate * 2 + 137) / rate
    signal = np.column_stack(
        (np.sin(2 * np.pi * 440 * time), np.sin(2 * np.pi * 659.25 * time))
    ) * (ceiling if prepared_headroom else 0.5)
    source = tmp_path / "source.wav"
    sf.write(source, signal, rate, subtype="PCM_24")
    melody = tmp_path / "melody.wav"
    sf.write(melody, signal, rate, subtype="PCM_16")
    lyrics = LyricsDocument(
        "Song",
        "Singer",
        len(signal) / rate,
        120,
        "A",
        "la",
        (Word("la", 0.1, 0.9, (Note(69, 0.2, 0.8),)),),
    )
    provenance = {"playbackPeakDbfs": -18} if prepared_headroom else {}
    original_source = source.read_bytes()
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song = import_song(client, source)
        publisher = client.app.state.container.songs.start_processing._pipeline._publisher
        first = publisher.publish_generated(
            song["songId"], 1, source, source, melody, lyrics, provenance, "lineage"
        )
        storage = publisher._storage
        original_stems = {
            logical: storage.artifact_path(song["songId"], first, logical)
            for logical in ("instrumental", "referenceVocal")
        }
        old_root = original_stems["instrumental"].parent.parent
        old_hashes = {path: sha256_file(path) for path in old_root.rglob("*") if path.is_file()}
        for stem in original_stems.values():
            assert stem.suffix == ".mp3"
            samples, _ = sf.read(stem, always_2d=True)
            # Even the correctly prepared MP3 slightly overshoots its PCM source peak.
            assert np.max(np.abs(samples)) > ceiling

        if prepared_headroom:

            def unexpected_encode(*args, **kwargs):
                raise AssertionError("Reprocessing timings must not encode existing MP3 again")

            monkeypatch.setattr(project_audio, "_encode", unexpected_encode)

        started = client.post(f"/songs/{song['songId']}/processing/{operation}")
        assert started.status_code == 202, started.text
        job = wait_for_job(client, started.json()["jobId"])
        assert job["state"] == "Succeeded", job
        revision = client.get(f"/songs/{song['songId']}").json()["activeRevision"]
        assert revision > first
        for logical, original in original_stems.items():
            regenerated = storage.artifact_path(song["songId"], revision, logical)
            before, after = sf.info(original), sf.info(regenerated)
            assert (before.frames, before.samplerate, before.channels) == (
                after.frames,
                after.samplerate,
                after.channels,
            )
            if prepared_headroom:
                assert sha256_file(regenerated) == old_hashes[original]
            else:
                samples, _ = sf.read(regenerated, always_2d=True)
                assert 20 * np.log10(np.max(np.abs(samples))) == pytest.approx(-18, abs=0.1)
        assert {path: sha256_file(path) for path in old_hashes} == old_hashes
        assert storage.load_manifest(song["songId"], revision).provenance["playbackPeakDbfs"] == -18
    assert source.read_bytes() == original_source
