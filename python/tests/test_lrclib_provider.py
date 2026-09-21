from __future__ import annotations

import threading
import urllib.error
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest

from backend.domain_errors import DependencyError
from backend.infrastructure.lrclib_provider import LrclibLyricsProvider
from backend.lyrics.discovery import LyricsDiscovery, LyricsMatchPolicy
from backend.lyrics.ports import LyricsCandidate
from backend.songs.domain import Language, Song, SongStatus, SourceState
from backend.songs.filename_metadata import UNKNOWN_ARTIST
from tests.fakes import FakeAiProvider, FakeLyricsProvider

_ROWS = (
    '[{"trackName": "Кофе мой друг", "artistName": "Нервы", "duration": 188,'
    ' "syncedLyrics": "[00:10.50] Кофе мой друг\\n[00:14.00] Музыка мой драйв", "plainLyrics": "x"}]'
)


def _song(title: str, artist: str, duration: float | None = 188.0) -> Song:
    now = datetime(2026, 1, 1, tzinfo=UTC)
    return Song(
        "s",
        title,
        artist,
        "id",
        SourceState.MANAGED,
        None,
        SongStatus.IMPORTED,
        1,
        2,
        now,
        now,
        duration=duration,
    )


class _Recorder:
    def __init__(self, *responses: str | Exception) -> None:
        self.urls: list[str] = []
        self._responses = list(responses)

    def __call__(self, url: str, timeout: float) -> str:
        self.urls.append(url)
        response = self._responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def test_searches_by_cleaned_title_and_artist_and_returns_plain_text() -> None:
    fetch = _Recorder(_ROWS)
    provider = LrclibLyricsProvider(fetch=fetch)

    result = provider.search(
        _song("Кофе мой друг (zaycev.net)", "Нервы"), Language.AUTO, threading.Event()
    )

    query = parse_qs(urlparse(fetch.urls[0]).query)
    assert query == {"track_name": ["Кофе мой друг"], "artist_name": ["Нервы"]}
    assert result[0].lyrics == "Кофе мой друг\nМузыка мой драйв"
    assert result[0].duration == 188.0


def test_falls_back_to_title_only_search_when_the_artist_search_is_empty() -> None:
    fetch = _Recorder("[]", _ROWS)
    provider = LrclibLyricsProvider(fetch=fetch)

    result = provider.search(_song("Кофе мой друг", "Нервы"), Language.AUTO, threading.Event())

    assert "artist_name" not in urlparse(fetch.urls[1]).query
    assert len(result) == 1


def test_unknown_artist_is_not_sent() -> None:
    fetch = _Recorder(_ROWS)
    LrclibLyricsProvider(fetch=fetch).search(
        _song("Кофе мой друг", UNKNOWN_ARTIST), Language.AUTO, threading.Event()
    )
    assert "artist_name" not in urlparse(fetch.urls[0]).query


@pytest.mark.parametrize(
    ("failure", "code"),
    [
        (urllib.error.HTTPError("u", 429, "busy", None, None), "ProviderRateLimited"),
        (TimeoutError(), "ProviderTimeout"),
        (OSError("offline"), "ProviderUnavailable"),
        ("not json", "ProviderUnavailable"),
    ],
)
def test_failures_become_provider_dependency_errors(failure: Exception | str, code: str) -> None:
    provider = LrclibLyricsProvider(fetch=_Recorder(failure))
    with pytest.raises(DependencyError) as error:
        provider.search(_song("Title", "Artist"), Language.AUTO, threading.Event())
    assert error.value.code == code


class _NoSidecar:
    def read(self, source: Path) -> str | None:
        return None


def _discover(candidate: LyricsCandidate, song: Song) -> tuple[str, str]:
    discovery = LyricsDiscovery(
        _NoSidecar(), (FakeLyricsProvider([(candidate,)]),), LyricsMatchPolicy()
    )
    result = discovery.discover(
        song, Path("vocal.wav"), FakeAiProvider(), threading.Event(), online_enabled=True
    )
    return result.lyrics, result.source


def test_catalog_names_that_differ_from_the_file_name_still_match() -> None:
    candidate = LyricsCandidate("catalog text", "Кофе мой друг", "Нервы", 190.0, "fake-lyrics")

    assert _discover(candidate, _song("Кофе мой Друг (zaycev.net)", "нервы")) == (
        "catalog text",
        "fake-lyrics",
    )


def test_a_different_song_is_rejected_so_the_model_transcribes() -> None:
    candidate = LyricsCandidate("other text", "Совсем другая песня", "Другой", 190.0, "fake-lyrics")

    lyrics, source = _discover(candidate, _song("Кофе мой друг", "Нервы"))

    assert source == "ASR"
    assert lyrics != "other text"


def test_a_dash_between_words_is_not_kept_as_a_word() -> None:
    rows = r'[{"trackName": "T", "artistName": "A", "plainLyrics": "Кофе – мой друг\nмузыка - мой драйв"}]'
    provider = LrclibLyricsProvider(fetch=_Recorder(rows))

    result = provider.search(_song("T", "A"), Language.AUTO, threading.Event())

    assert result[0].lyrics == "Кофе мой друг\nмузыка мой драйв"
