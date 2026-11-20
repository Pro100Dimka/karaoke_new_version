from __future__ import annotations

from pathlib import Path

import pytest

from backend.infrastructure.ffmpeg_media import FfmpegMediaInspector
from backend.infrastructure.process_runner import ProcessRunner
from tests.conftest import app_client, write_wav
from tests.helpers import wait_for_job

pytestmark = pytest.mark.integration


@pytest.mark.parametrize(("suffix", "codec"), [(".ogg", "libvorbis"), (".opus", "libopus")])
@pytest.mark.parametrize("tag_case", ["lower", "mixed"])
def test_import_retains_tags_from_an_audio_stream(
    tmp_path: Path, suffix: str, codec: str, tag_case: str
) -> None:
    wave = tmp_path / "fixture.wav"
    source = tmp_path / f"untitled{suffix}"
    write_wav(wave, seconds=0.2)
    tags = {
        "title": "Моя пісня",
        "artist": "Виконавець",
        "album": "Мій альбом",
        "lyrics": "Перший рядок\nДругий рядок",
    }
    command = ["ffmpeg", "-v", "error", "-i", str(wave), "-c:a", codec]
    for key, value in tags.items():
        name = key.capitalize() if tag_case == "mixed" else key
        command.extend(["-metadata", f"{name}={value}"])
    encoded = ProcessRunner().run([*command, str(source)], timeout_seconds=15)
    assert encoded.exit_code == 0, encoded.stderr
    original = source.read_bytes()

    with app_client(tmp_path / "runtime") as client:
        started = client.post("/songs/imports", json={"sourcePath": str(source)})
        assert started.status_code == 202, started.text
        completed = wait_for_job(client, started.json()["jobId"])
        assert completed["state"] == "Succeeded", completed
        song = client.get(f"/songs/{completed['report']['songId']}").json()
        assert song["title"] == tags["title"]
        assert song["artist"] == tags["artist"]
        assert song["album"] == tags["album"]
        stored = client.app.state.container.songs.get_song.execute(song["songId"])
        assert stored.embedded_lyrics == tags["lyrics"]
        assert stored.source_path.read_bytes() == original
        assert source.read_bytes() == original


def test_container_tags_keep_priority_and_audio_stream_fills_only_missing_fields() -> None:
    metadata = FfmpegMediaInspector._metadata(
        {
            "format": {
                "duration": "1.0",
                "tags": {"title": "Container title", "album": "Container album", "lyrics": " "},
            },
            "streams": [
                {"codec_type": "video", "tags": {"artist": "Cover artist", "lyrics": "Cover"}},
                {
                    "codec_type": "audio",
                    "tags": {
                        "TITLE": "Stream title",
                        "ARTIST": "Stream artist",
                        "ALBUM": "Stream album",
                        "LYRICS": "Stream lyrics",
                    },
                },
            ],
        },
        Path("untitled.ogg"),
    )

    assert metadata.title == "Container title"
    assert metadata.artist == "Stream artist"
    assert metadata.album == "Container album"
    assert metadata.embedded_lyrics == "Stream lyrics"


def test_container_lyrics_alias_keeps_priority_over_stream_lyrics() -> None:
    metadata = FfmpegMediaInspector._metadata(
        {
            "format": {"tags": {"unsyncedlyrics": "Container lyrics"}},
            "streams": [{"codec_type": "audio", "tags": {"lyrics": "Stream lyrics"}}],
        },
        Path("song.ogg"),
    )

    assert metadata.embedded_lyrics == "Container lyrics"


def test_meaningful_mixed_case_container_tags_keep_priority_over_stream_tags() -> None:
    metadata = FfmpegMediaInspector._metadata(
        {
            "format": {
                "tags": {
                    "title": " ",
                    "Title": "Container title",
                    "aRtIsT": "Container artist",
                    "UnSyncedLyrics": "Container lyrics",
                },
            },
            "streams": [
                {
                    "codec_type": "audio",
                    "tags": {"TITLE": "Stream title", "ARTIST": "Stream artist", "LYRICS": "Stream"},
                },
            ],
        },
        Path("song.ogg"),
    )

    assert metadata.title == "Container title"
    assert metadata.artist == "Container artist"
    assert metadata.embedded_lyrics == "Container lyrics"
