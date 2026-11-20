from __future__ import annotations

import json
import threading
from pathlib import Path

import pytest

from backend.infrastructure.ffmpeg_media import FfmpegMediaInspector
from backend.infrastructure.process_runner import ProcessRunner
from backend.infrastructure.sidecar_lyrics import LocalSidecarLyricsReader
from backend.lyrics.discovery import LyricsDiscovery, LyricsMatchPolicy
from tests.conftest import app_client, write_wav
from tests.helpers import wait_for_job

pytestmark = pytest.mark.integration


def _syncsafe(value: int) -> bytes:
    return bytes((value >> shift) & 0x7F for shift in (21, 14, 7, 0))


def _mp3_with_uslt(tmp_path: Path, language: str, descriptor: str, lyrics: str) -> Path:
    wave, source = tmp_path / "audio.wav", tmp_path / "Song.mp3"
    write_wav(wave, seconds=0.2)
    encoded = ProcessRunner().run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(wave),
            "-c:a",
            "libmp3lame",
            "-id3v2_version",
            "0",
            "-write_id3v1",
            "0",
            str(source),
        ],
        timeout_seconds=15,
    )
    assert encoded.exit_code == 0, encoded.stderr
    audio = source.read_bytes()
    assert not audio.startswith(b"ID3")
    # ID3v2.4 USLT: UTF-8 encoding, three-byte language, terminated descriptor, lyrics.
    payload = b"\x03" + language.encode("ascii") + descriptor.encode("utf-8") + b"\0"
    payload += lyrics.encode("utf-8")
    frame = b"USLT" + _syncsafe(len(payload)) + b"\0\0" + payload
    source.write_bytes(b"ID3\x04\0\0" + _syncsafe(len(frame)) + frame + audio)
    return source


@pytest.mark.parametrize(("language", "descriptor"), [("ukr", ""), ("eng", "Original")])
def test_import_preserves_id3_lyrics_with_language_and_descriptor(
    tmp_path: Path, language: str, descriptor: str
) -> None:
    lyrics = "Перший рядок\nДругий рядок"
    source = _mp3_with_uslt(tmp_path, language, descriptor, lyrics)
    original = source.read_bytes()
    probe = ProcessRunner().run(
        ["ffprobe", "-v", "error", "-show_format", "-of", "json", str(source)],
        timeout_seconds=15,
    )
    assert probe.exit_code == 0, probe.stderr
    key = f"lyrics-{descriptor}-{language}" if descriptor else f"lyrics-{language}"
    assert json.loads(probe.stdout)["format"]["tags"][key] == lyrics

    with app_client(tmp_path / "runtime") as client:
        started = client.post("/songs/imports", json={"sourcePath": str(source)})
        assert started.status_code == 202, started.text
        completed = wait_for_job(client, started.json()["jobId"])
        assert completed["state"] == "Succeeded", completed
        song = client.app.state.container.songs.get_song.execute(completed["report"]["songId"])
        assert song.embedded_lyrics == lyrics
        found = (
            LyricsDiscovery(LocalSidecarLyricsReader(), (), LyricsMatchPolicy())
            .lookup(song, threading.Event(), False)
            .found
        )
        assert found is not None and found.lyrics == lyrics
        assert song.source_path.read_bytes() == original
        assert source.read_bytes() == original


@pytest.mark.parametrize("canonical", ["lyrics", "unsyncedlyrics"])
def test_unqualified_lyrics_keep_priority_over_qualified_variants(canonical: str) -> None:
    metadata = FfmpegMediaInspector._metadata(
        {"format": {"tags": {"lyrics-eng": "Translated text", canonical: "Original text"}}},
        Path("song.mp3"),
    )

    assert metadata.embedded_lyrics == "Original text"


def test_qualified_container_lyrics_keep_priority_over_audio_stream_lyrics() -> None:
    metadata = FfmpegMediaInspector._metadata(
        {
            "format": {"tags": {"lyrics-ukr": "Container lyrics"}},
            "streams": [{"codec_type": "audio", "tags": {"lyrics": "Stream lyrics"}}],
        },
        Path("song.mp3"),
    )

    assert metadata.embedded_lyrics == "Container lyrics"


def test_qualified_lyrics_skip_empty_values_and_do_not_join_translations() -> None:
    metadata = FfmpegMediaInspector._metadata(
        {
            "format": {
                "tags": {
                    "lyrics": " ",
                    "lyrics-eng": "\n",
                    "lyrics-rus": None,
                    "LyRiCs-Original-UKR": "  Український текст  ",
                    "lyrics-Translation-eng": "English translation",
                },
            },
        },
        Path("song.mp3"),
    )

    assert metadata.embedded_lyrics == "Український текст"


def test_unrelated_metadata_is_not_used_as_lyrics_or_a_title() -> None:
    metadata = FfmpegMediaInspector._metadata(
        {
            "format": {
                "tags": {
                    "lyricist": "Writer",
                    "lyricsUrl": "https://example.test/lyrics",
                    "lyrics_count": "12",
                    "lyrics-": "Missing modifier",
                    "title-sort": "Sorted",
                },
            },
        },
        Path("song.mp3"),
    )

    assert metadata.embedded_lyrics is None
    assert metadata.title == "song"
