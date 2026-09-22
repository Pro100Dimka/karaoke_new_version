from __future__ import annotations

import asyncio
from pathlib import Path

from backend.infrastructure.shazam_recognition import ShazamRecognitionProvider


def test_shazam_fingerprint_maps_complete_song_metadata(tmp_path: Path) -> None:
    source = tmp_path / "wrong filename.mp3"
    source.write_bytes(b"audio")

    async def recognize(path: Path) -> object:
        assert path == source
        return {
            "track": {
                "key": "538829124",
                "title": "Animals",
                "subtitle": "Architects",
                "genres": {"primary": "Hard Rock"},
                "images": {"coverarthq": "https://img.example/400x400cc.jpg"},
                "sections": [
                    {
                        "type": "SONG",
                        "metadata": [{"title": "Album", "text": "For Those That Wish to Exist"}],
                    }
                ],
            }
        }

    provider = ShazamRecognitionProvider(
        recognize=recognize,
        find_video=lambda artist, title: "https://www.youtube.com/watch?v=correct12345",
    )

    result = provider.recognize(source)

    assert result is not None
    assert (result.artist, result.title) == ("Architects", "Animals")
    assert result.album == "For Those That Wish to Exist"
    assert result.genre == "Hard Rock"
    assert result.artwork_url == "https://img.example/1200x1200bb.jpg"
    assert result.video_url == "https://www.youtube.com/watch?v=correct12345"
    assert result.provider == "Shazam"
    assert result.external_id == "538829124"


def test_shazam_fingerprint_returns_none_when_audio_has_no_match(tmp_path: Path) -> None:
    source = tmp_path / "unknown.mp3"
    source.write_bytes(b"audio")

    async def recognize(_path: Path) -> object:
        return {"matches": []}

    assert ShazamRecognitionProvider(recognize=recognize).recognize(source) is None


def test_shazam_rejects_a_conflicting_title_for_the_same_filename_artist(
    tmp_path: Path,
) -> None:
    source = tmp_path / "5ivesta Family - Зачем.mp3"
    source.write_bytes(b"audio")

    async def recognize(_path: Path) -> object:
        return {
            "track": {
                "key": "wrong",
                "title": "Spring Summer",
                "subtitle": "5sta Family",
            }
        }

    assert ShazamRecognitionProvider(recognize=recognize).recognize(source) is None


def test_shazam_rejects_a_completely_different_song_than_the_named_source(
    tmp_path: Path,
) -> None:
    source = tmp_path / "Architects - Animals.mp3"
    source.write_bytes(b"audio")

    async def recognize(_path: Path) -> object:
        return {
            "track": {
                "key": "wrong",
                "title": "Blinding Lights",
                "subtitle": "The Weeknd",
            }
        }

    assert ShazamRecognitionProvider(recognize=recognize).recognize(source) is None


def test_shazam_fingerprint_has_a_bounded_network_wait(tmp_path: Path) -> None:
    source = tmp_path / "Artist - Song.mp3"
    source.write_bytes(b"audio")

    async def recognize(_path: Path) -> object:
        await asyncio.Event().wait()
        return {}

    provider = ShazamRecognitionProvider(recognize=recognize, timeout_seconds=0.01)

    assert provider.recognize(source) is None
