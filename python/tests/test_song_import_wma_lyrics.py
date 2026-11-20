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


def test_import_preserves_windows_media_lyrics(tmp_path: Path) -> None:
    wave, source = tmp_path / "source.wav", tmp_path / "Пісня.wma"
    write_wav(wave, seconds=0.2)
    lyrics = "Перший рядок пісні\nДругий рядок пісні"
    runner = ProcessRunner()
    encoded = runner.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(wave),
            "-c:a",
            "wmav2",
            "-metadata",
            f"WM/Lyrics={lyrics}",
            str(source),
        ],
        timeout_seconds=15,
    )
    assert encoded.exit_code == 0, encoded.stderr
    probe = runner.run(
        ["ffprobe", "-v", "error", "-show_format", "-of", "json", str(source)],
        timeout_seconds=15,
    )
    assert probe.exit_code == 0, probe.stderr
    assert json.loads(probe.stdout)["format"]["tags"]["WM/Lyrics"] == lyrics
    original = source.read_bytes()

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


@pytest.mark.parametrize("existing", ["lyrics", "unsyncedlyrics", "lyrics-eng"])
def test_windows_media_lyrics_do_not_replace_existing_lyrics_aliases(existing: str) -> None:
    metadata = FfmpegMediaInspector._metadata(
        {"format": {"tags": {"WM/Lyrics": "Windows text", existing: "Existing text"}}},
        Path("song.wma"),
    )

    assert metadata.embedded_lyrics == "Existing text"


@pytest.mark.parametrize("key", ["WM/Lyrics", "wM/LyRiCs"])
def test_windows_media_lyrics_fill_missing_or_blank_generic_lyrics(key: str) -> None:
    metadata = FfmpegMediaInspector._metadata(
        {
            "format": {
                "tags": {
                    "lyrics": " ",
                    "unsyncedlyrics": None,
                    "lyrics-eng": "\n",
                    key: "  Windows text  ",
                },
            },
        },
        Path("song.wma"),
    )

    assert metadata.embedded_lyrics == "Windows text"


def test_windows_media_fallback_does_not_replace_a_previously_used_audio_stream() -> None:
    metadata = FfmpegMediaInspector._metadata(
        {
            "format": {"tags": {"WM/Lyrics": "Windows text"}},
            "streams": [{"codec_type": "audio", "tags": {"lyrics": "Existing stream text"}}],
        },
        Path("song.wma"),
    )

    assert metadata.embedded_lyrics == "Existing stream text"


def test_structured_windows_media_lyrics_are_not_treated_as_plain_text() -> None:
    metadata = FfmpegMediaInspector._metadata(
        {"format": {"tags": {"WM/Lyrics_Synchronised": "Structured data"}}},
        Path("song.wma"),
    )

    assert metadata.embedded_lyrics is None
