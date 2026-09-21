from __future__ import annotations

from pathlib import Path

import pytest

from backend.songs.filename_metadata import split_artist_title, with_filename_fallback
from backend.songs.ports import MediaMetadata


def _metadata(title: str, artist: str) -> MediaMetadata:
    return MediaMetadata(
        title=title,
        artist=artist,
        album=None,
        duration=10.0,
        media_format="wav",
        embedded_lyrics=None,
        has_embedded_artwork=False,
    )


@pytest.mark.parametrize(
    ("stem", "expected"),
    [
        ("Бумбокс - Люди", ("Бумбокс", "Люди")),
        ("Artist – Title", ("Artist", "Title")),
        ("A - B - C", ("A", "B - C")),
        ("JustATitle", None),
        (" - Title", None),
        ("Artist - ", None),
    ],
)
def test_split_artist_title(stem: str, expected: tuple[str, str] | None) -> None:
    assert split_artist_title(stem) == expected


def test_filename_fills_missing_tags() -> None:
    source = Path("Test Artist - Test Song.wav")
    result = with_filename_fallback(_metadata("Test Artist - Test Song", "Unknown Artist"), source)
    assert (result.artist, result.title) == ("Test Artist", "Test Song")


def test_embedded_tags_win_over_the_filename() -> None:
    source = Path("Other - Name.mp3")
    result = with_filename_fallback(_metadata("Real Title", "Real Artist"), source)
    assert (result.artist, result.title) == ("Real Artist", "Real Title")


def test_name_without_separator_is_left_alone() -> None:
    source = Path("song.wav")
    metadata = _metadata("song", "Unknown Artist")
    assert with_filename_fallback(metadata, source) == metadata
