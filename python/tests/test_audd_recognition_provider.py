from __future__ import annotations

import threading
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
        url = str(getattr(request, "full_url"))
        requested.append(url)
        assert timeout == 7.0
        if "oembed?" in url:
            return b'{"title":"5sta Family - Zachem (Official Video)","author_name":"5sta Family"}'
        return b'{"videoId":"cEQ6-8J-P3I"}'

    result = YoutubeVideoFinder(None, timeout_seconds=7.0, get=get)("5sta Family", "Зачем")

    assert result == "https://www.youtube.com/watch?v=cEQ6-8J-P3I"
    assert "youtube.com/results?" in requested[0]


def test_youtube_finder_skips_topic_audio_and_selects_matching_clip() -> None:
    topic_id = "1WSTfgufuNc"
    clip_id = "NoJcYpbWY_k"

    def get(request: object, _timeout: float) -> bytes:
        url = str(getattr(request, "full_url"))
        if "results?" in url:
            return f'{{"videoId":"{topic_id}"}}{{"videoId":"{clip_id}"}}'.encode()
        if topic_id in url:
            return b'{"title":"MoralFuck","author_name":"2rbina 2rista - Topic"}'
        return b'{"title":"2rbina 2rista - MoralFuck (Official Video)","author_name":"2rbina 2rista Music"}'

    result = YoutubeVideoFinder(None, get=get)("2rbina 2rista", "MoralFuck")

    assert result == f"https://www.youtube.com/watch?v={clip_id}"


def test_youtube_finder_accepts_transliterated_artist_spelling() -> None:
    clip_id = "abcDEF12345"

    def get(request: object, _timeout: float) -> bytes:
        url = str(getattr(request, "full_url"))
        if "results?" in url:
            return f'{{"videoId":"{clip_id}"}}'.encode()
        return '{"title":"Антитіла - Лови момент (official video)","author_name":"Антитіла"}'.encode()

    assert YoutubeVideoFinder(None, get=get)("Antytila", "Лови момент") == (
        f"https://www.youtube.com/watch?v={clip_id}"
    )


def test_youtube_finder_validates_public_candidates_concurrently() -> None:
    video_ids = ["abcDEF12345", "abcDEF12346", "abcDEF12347"]
    lock = threading.Lock()
    request_barrier = threading.Barrier(len(video_ids))
    active_requests = 0
    maximum_active_requests = 0

    def get(request: object, _timeout: float) -> bytes:
        nonlocal active_requests, maximum_active_requests
        url = str(getattr(request, "full_url"))
        if "results?" in url:
            return "".join(f'{{"videoId":"{item}"}}' for item in video_ids).encode()
        with lock:
            active_requests += 1
            maximum_active_requests = max(maximum_active_requests, active_requests)
        try:
            request_barrier.wait(timeout=0.2)
        except threading.BrokenBarrierError:
            pass
        with lock:
            active_requests -= 1
        return b'{"title":"Artist - Song (Official Video)","author_name":"Artist"}'

    assert YoutubeVideoFinder(None, get=get)("Artist", "Song") is not None
    assert maximum_active_requests >= 2


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


def test_catalog_search_rejects_a_different_artist_with_the_same_title(tmp_path: Path) -> None:
    source = tmp_path / "Architects - Animals.mp3"
    source.write_bytes(b"audio")
    payload = b'{"results":[{"artistName":"The Native Architects","trackName":"Animals","collectionName":"Animals - Single","primaryGenreName":"Alternative"}]}'
    catalog = ItunesCatalogRecognitionProvider(
        get=lambda request, timeout: payload,
        find_video=lambda artist, title: None,
    )

    assert catalog.recognize(source) is None


class FakeNoMatchRecognizer:
    def recognize(self, source: Path) -> RecognizedSong | None:
        assert source.is_file()
        return None
