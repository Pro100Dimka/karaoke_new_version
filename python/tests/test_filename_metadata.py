from __future__ import annotations

from pathlib import Path

import pytest

from backend.songs.filename_metadata import (
    clean_site_tags,
    split_artist_title,
    with_filename_fallback,
)
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
        ("Bad Omens-Just Pretend", ("Bad Omens", "Just Pretend")),
        ("Architects-Animals", ("Architects", "Animals")),
        ("2rbina_2rista_-_moralfuck", ("2rbina 2rista", "moralfuck")),
        ("4 Апреля_- За тобой", ("4 Апреля", "За тобой")),
        ("Artist-Some-Title", None),
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


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Кофе - Мой Друг (zaycev.net)", "Кофе - Мой Друг"),
        ("Girlfriend [Sefon.Pro]", "Girlfriend"),
        ("Obormot (Remix) (Muzlike.net)", "Obormot (Remix)"),
        ("TANZNEID (new.muzikavsem.org)", "TANZNEID"),
        ("Song - www.muzlike.net", "Song"),
        ("Gori moya lyubov (musmore.org)", "Gori moya lyubov"),
        ("V.A.N", "V.A.N"),
        ("Unravel (Live)", "Unravel (Live)"),
        ("zaycev.net", "zaycev.net"),
    ],
)
def test_download_site_addresses_are_removed(raw: str, expected: str) -> None:
    assert clean_site_tags(raw) == expected


def test_site_addresses_are_dropped_from_title_artist_and_album() -> None:
    metadata = MediaMetadata(
        "Song (zaycev.net)", "Band [Sefon.Pro]", "Album (musmore.org)", 10.0, "mp3", None, False
    )
    result = with_filename_fallback(metadata, Path("x.mp3"))
    assert (result.title, result.artist, result.album) == ("Song", "Band", "Album")
