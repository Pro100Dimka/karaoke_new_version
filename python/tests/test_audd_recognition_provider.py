from __future__ import annotations

from pathlib import Path

from backend.infrastructure.audd_recognition import (
    AuddRecognitionProvider,
    FallbackSongRecognitionProvider,
    ItunesCatalogRecognitionProvider,
    YoutubeVideoFinder,
)
from backend.songs.recognition import RecognizedSong


def test_audd_metadata_maps_cover_genre_and_optional_youtube_clip(tmp_path: Path) -> None:
    source = tmp_path / "clip.wav"
    source.write_bytes(b"RIFF-audio")
    calls: list[str] = []

    def post(url: str, fields: dict[str, str], file_path: Path, timeout: float) -> object:
        calls.append(url)
        assert fields["return"] == "apple_music,spotify"
        assert file_path == source
        assert timeout == 7.0
        return {
            "status": "success",
            "result": {
                "artist": "Kate Bush",
                "title": "Running Up That Hill",
                "album": "Hounds of Love",
                "song_link": "https://lis.tn/example",
                "apple_music": {
                    "id": "123",
                    "genreNames": ["Pop", "Music"],
                    "artwork": {"url": "https://img.example/{w}x{h}bb.jpg"},
                },
            },
        }

    def find_video(artist: str, title: str) -> str | None:
        assert (artist, title) == ("Kate Bush", "Running Up That Hill")
        return "https://www.youtube.com/watch?v=wp43OdtAAkM"

    result = AuddRecognitionProvider(
        "token", timeout_seconds=7.0, post=post, find_video=find_video
    ).recognize(source)

    assert calls == ["https://api.audd.io/"]
    assert result is not None
    assert result.genre == "Pop"
    assert result.artwork_url == "https://img.example/1200x1200bb.jpg"
    assert result.video_url == "https://www.youtube.com/watch?v=wp43OdtAAkM"


def test_youtube_finder_uses_public_search_when_no_api_key_is_configured() -> None:
    requested: list[str] = []

    def get(request: object, timeout: float) -> bytes:
        requested.append(str(getattr(request, "full_url")))
        assert timeout == 7.0
        return b'{"videoId":"cEQ6-8J-P3I"}'

    result = YoutubeVideoFinder(None, timeout_seconds=7.0, get=get)("5sta Family", "Зачем")

    assert result == "https://www.youtube.com/watch?v=cEQ6-8J-P3I"
    assert "youtube.com/results?" in requested[0]


def test_catalog_search_fills_metadata_when_audio_fingerprint_has_no_match(tmp_path: Path) -> None:
    source = tmp_path / "Нервы - Нервы.mp3"
    source.write_bytes(b"audio")
    payload = """{"results":[{"artistName":"Nervy","trackName":"Нервы","collectionName":"Всё Что Вокруг","primaryGenreName":"Alternative","artworkUrl100":"https://img.example/100x100bb.jpg","trackId":42}]}""".encode()
    catalog = ItunesCatalogRecognitionProvider(
        get=lambda request, timeout: payload,
        find_video=lambda artist, title: "https://www.youtube.com/watch?v=catalog1234",
    )
    primary = FakeNoMatchRecognizer()

    result = FallbackSongRecognitionProvider(primary, catalog).recognize(source)

    assert result is not None
    assert result.title == "Нервы"
    assert result.album == "Всё Что Вокруг"
    assert result.genre == "Alternative"
    assert result.artwork_url == "https://img.example/1200x1200bb.jpg"
    assert result.video_url == "https://www.youtube.com/watch?v=catalog1234"
    assert result.provider == "Apple Music Search"


def test_catalog_search_matches_transliterated_artist_and_mixed_alphabet_title(
    tmp_path: Path,
) -> None:
    source = tmp_path / "Балабама - Надия.mp3"
    source.write_bytes(b"audio")
    payload = """{"results":[{"artistName":"Balabama","trackName":"Надiя","collectionName":"Будет всё хорошо","primaryGenreName":"Pop","artworkUrl100":"https://img.example/100x100bb.jpg","trackId":1619766947}]}""".encode()
    catalog = ItunesCatalogRecognitionProvider(
        get=lambda request, timeout: payload,
        find_video=lambda artist, title: "https://www.youtube.com/watch?v=avb9IDY6AFo",
    )

    result = catalog.recognize(source)

    assert result is not None
    assert result.artist == "Balabama"
    assert result.title == "Надiя"
    assert result.album == "Будет всё хорошо"
    assert result.genre == "Pop"
    assert result.external_id == "1619766947"


class FakeNoMatchRecognizer:
    def recognize(self, source: Path) -> RecognizedSong | None:
        assert source.is_file()
        return None
