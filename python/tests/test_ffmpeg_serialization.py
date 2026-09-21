from __future__ import annotations

import pytest
import threading
from datetime import UTC, datetime
from pathlib import Path

from backend.infrastructure.ffmpeg_audio import FfmpegAudioNormalizer, FfmpegAudioValidator
from backend.infrastructure.ffmpeg_media import FfmpegMediaInspector
from backend.infrastructure.process_runner import ProcessRunner
from backend.lyrics.codec import decode_document, encode_document
from backend.lyrics.domain import LyricsDocument, Note, Word
from backend.projects.domain import ArtifactCategory, ProjectArtifact, ProjectManifest
from backend.projects.manifest_codec import decode_manifest, encode_manifest
from backend.serialization import dumps, loads_object
from tests.conftest import write_wav


pytestmark = pytest.mark.integration


def test_ffmpeg_minimal_media_contract(tmp_path: Path) -> None:
    source = tmp_path / "source.wav"
    normalized = tmp_path / "normalized.wav"
    write_wav(source, seconds=0.2)
    runner = ProcessRunner()

    metadata = FfmpegMediaInspector(runner).inspect(source)
    FfmpegAudioNormalizer(runner).normalize(
        source,
        normalized,
        threads=1,
        cancel=threading.Event(),
    )
    FfmpegAudioValidator(runner).validate(normalized)

    assert metadata.duration is not None and metadata.duration > 0
    assert normalized.is_file() and normalized.stat().st_size > 0


def test_project_manifest_serialization_round_trip() -> None:
    manifest = ProjectManifest(
        project_format_version=2,
        song_id="song-1",
        revision=3,
        artifacts=(
            ProjectArtifact(
                "lyricsSync",
                Path("lyricsSync.json"),
                ArtifactCategory.PORTABLE,
                "abc123",
            ),
        ),
        provenance={"algorithmVersion": "pipeline-1"},
    )
    assert decode_manifest(encode_manifest(manifest)) == manifest


def test_lyrics_document_serialization_round_trip() -> None:
    document = LyricsDocument(
        "Title",
        "Artist",
        1.0,
        120.0,
        "A",
        "la",
        (Word("la", 0.0, 1.0, (Note(69, 0.1, 0.9),)),),
    )
    assert decode_document(encode_document(document)) == document


def test_canonical_json_preserves_unicode_and_utc_timestamp() -> None:
    instant = datetime(2026, 9, 18, 12, 30, tzinfo=UTC)
    raw = dumps({"text": "Привіт", "createdAt": instant})
    decoded = loads_object(raw)
    assert decoded["text"] == "Привіт"
    assert decoded["createdAt"] == "2026-09-18T12:30:00+00:00"
