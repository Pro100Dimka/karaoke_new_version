from __future__ import annotations

import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.domain_errors import DomainError
from backend.infrastructure.oracle_ai_provider import OracleAiProvider
from backend.lyrics.codec import encode_document
from backend.lyrics.domain import LyricsDocument
from backend.processing.domain import ProcessingMode, ProcessingOptions
from backend.songs.domain import Language


def _completed_response(directory: Path, extension: str | None):
    names = {
        "instrumental": "instrumental" + (extension or ".flac"),
        "referenceVocal": "vocals" + (extension or ".flac"),
        "melody": "melody.flac",
    }
    for filename in names.values():
        (directory / filename).write_bytes(filename.encode())
    document = LyricsDocument("Song", "Singer", 10, None, None, "", ())
    (directory / "lyrics.json").write_text(encode_document(document), encoding="utf-8")
    response = {
        "report": {"stages": [], "warnings": [], "algorithmVersion": "pipeline-3"},
        "provenance": {"playbackPeakDbfs": -18},
    }
    if extension is not None:
        response["audioFiles"] = names
    return response, names


@pytest.mark.parametrize("extension", [None, ".mp3", ".flac", ".wav"])
def test_client_negotiates_compact_audio_and_accepts_legacy_or_named_files(
    tmp_path, monkeypatch, extension
):
    response, names = _completed_response(tmp_path, extension)
    source = tmp_path / "original.mp3"
    source.write_bytes(b"original")
    song = SimpleNamespace(
        song_id="song",
        active_revision=1,
        source_path=source,
        title="Song",
        artist="Singer",
        language=Language.AUTO,
        embedded_lyrics=None,
    )
    provider = OracleAiProvider(tmp_path / "transport")

    def invoke(action, options, files, cancel, output, progress):
        assert action == "process-song"
        assert options["compactProjectAudio"] is True
        assert files == {"source.mp3": source}
        assert output == tmp_path
        return response

    monkeypatch.setattr(provider, "_invoke", invoke)
    result = provider.process_song(
        song,
        ProcessingOptions(ProcessingMode.FAST, False),
        tmp_path,
        threading.Event(),
        lambda *args: None,
    )
    assert result.instrumental == tmp_path / names["instrumental"]
    assert result.reference_vocal == tmp_path / names["referenceVocal"]
    assert result.melody == tmp_path / names["melody"]
    assert result.instrumental.read_bytes() == names["instrumental"].encode()
    assert result.document.title == "Song"


@pytest.mark.parametrize(
    "bad_name",
    [
        "../instrumental.mp3",
        "sub/instrumental.mp3",
        "sub\\instrumental.mp3",
        "C:\\instrumental.mp3",
        "/instrumental.mp3",
        "instrumental.mp3:stream",
        "instrumental.ogg",
        "vocals.mp3",
        "payload.json",
        None,
        1,
    ],
)
def test_client_rejects_unsafe_or_unexpected_named_audio(tmp_path, bad_name):
    response, _ = _completed_response(tmp_path, ".mp3")
    response["audioFiles"]["instrumental"] = bad_name
    provider = OracleAiProvider(tmp_path / "transport")
    with pytest.raises(DomainError) as error:
        provider._completed_project(
            SimpleNamespace(song_id="song", active_revision=1), response, tmp_path
        )
    assert error.value.code == "AiProviderInvalidOutput"


@pytest.mark.parametrize("mapping", [None, [], {}, {"instrumental": "instrumental.mp3"}])
def test_client_rejects_malformed_audio_mapping_instead_of_silently_using_legacy_files(
    tmp_path, mapping
):
    response, _ = _completed_response(tmp_path, None)
    response["audioFiles"] = mapping
    provider = OracleAiProvider(tmp_path / "transport")
    with pytest.raises(DomainError) as error:
        provider._completed_project(
            SimpleNamespace(song_id="song", active_revision=1), response, tmp_path
        )
    assert error.value.code == "AiProviderInvalidOutput"


@pytest.mark.parametrize("alias", [False, True])
def test_client_rejects_missing_or_aliased_audio(tmp_path, alias):
    response, names = _completed_response(tmp_path, ".mp3")
    source = tmp_path / names["instrumental"]
    source.unlink()
    if alias:
        external = tmp_path / "other.mp3"
        external.write_bytes(b"external")
        try:
            source.symlink_to(external)
        except OSError:
            pytest.skip("Symlink creation is unavailable")
    provider = OracleAiProvider(tmp_path / "transport")
    with pytest.raises(DomainError) as error:
        provider._completed_project(
            SimpleNamespace(song_id="song", active_revision=1), response, tmp_path
        )
    assert error.value.code == "AiProviderInvalidOutput"
