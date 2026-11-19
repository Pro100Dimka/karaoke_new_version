from __future__ import annotations

import threading
import urllib.error
from datetime import UTC, datetime
from urllib.parse import parse_qs, urlparse

import pytest

from backend.domain_errors import DependencyError
from backend.infrastructure.tekst_pesenok_provider import TekstPesenokLyricsProvider
from backend.serialization import dumps
from backend.songs.domain import Language, Song, SongStatus, SourceState

TITLE = "Paper Lanterns"
ARTIST = "North Window"
LYRICS = "Paper lanterns wander slowly above sleeping houses tonight"


def _song() -> Song:
    now = datetime(2026, 1, 1, tzinfo=UTC)
    return Song(
        "song",
        TITLE,
        ARTIST,
        "audio",
        SourceState.MANAGED,
        None,
        SongStatus.IMPORTED,
        1,
        2,
        now,
        now,
        duration=180.0,
    )


def _row(url: str, title: str = TITLE, artist: str = ARTIST) -> str:
    return f'<tr><td><a>{artist}</a></td><td><a href="{url}">{title}</a></td></tr>'


def _page(title: str = TITLE, artist: str = ARTIST) -> str:
    data = {
        "@type": "MusicRecording",
        "name": title,
        "byArtist": {"name": artist},
        "recordingOf": {"lyrics": {"text": LYRICS}},
    }
    return '<script type="application/ld+json">' + dumps(data) + "</script>"


class _Fetch:
    def __init__(
        self,
        artist_search: str | Exception,
        title_search: str | Exception = "",
        **pages: str | Exception,
    ) -> None:
        self.responses = {ARTIST + " " + TITLE: artist_search, TITLE: title_search, **pages}
        self.calls: list[str] = []

    def __call__(self, url: str, timeout: float) -> str:
        parsed = urlparse(url)
        key = parse_qs(parsed.query).get("s", [parsed.path.lstrip("/")])[0]
        self.calls.append(key)
        value = self.responses[key]
        if isinstance(value, Exception):
            raise value
        return value


@pytest.mark.parametrize("order", ["good-first", "bad-first"])
@pytest.mark.parametrize(
    "failure", [TimeoutError(), urllib.error.HTTPError("u", 404, "gone", None, None)]
)
def test_one_unavailable_page_does_not_discard_other_candidates(order, failure) -> None:
    rows = [_row("good"), _row("bad")]
    fetch = _Fetch(
        "".join(rows if order == "good-first" else rows[::-1]), good=_page(), bad=failure
    )

    candidates = TekstPesenokLyricsProvider(fetch=fetch).search(
        _song(), Language.AUTO, threading.Event()
    )

    assert [candidate.lyrics for candidate in candidates] == [LYRICS]


def test_failed_artist_query_still_tries_the_title_query() -> None:
    fetch = _Fetch(TimeoutError(), _row("good"), good=_page())

    candidates = TekstPesenokLyricsProvider(fetch=fetch).search(
        _song(), Language.AUTO, threading.Event()
    )

    assert [candidate.lyrics for candidate in candidates] == [LYRICS]
    assert fetch.calls == [ARTIST + " " + TITLE, TITLE, "good"]


def test_unrelated_row_titles_are_not_fetched() -> None:
    fetch = _Fetch(_row("other", title="Midday Traffic") + _row("good"), good=_page())

    candidates = TekstPesenokLyricsProvider(fetch=fetch).search(
        _song(), Language.AUTO, threading.Event()
    )

    assert [candidate.lyrics for candidate in candidates] == [LYRICS]
    assert "other" not in fetch.calls


def test_page_metadata_still_rejects_a_wrong_title() -> None:
    fetch = _Fetch(_row("wrong"), wrong=_page(title="Midday Traffic"))

    assert not TekstPesenokLyricsProvider(fetch=fetch).search(
        _song(), Language.AUTO, threading.Event()
    )


def test_alias_candidate_is_available_for_later_performance_verification() -> None:
    fetch = _Fetch("", _row("alias", artist="N.W."), alias=_page(artist="N.W."))

    candidates = TekstPesenokLyricsProvider(fetch=fetch).search(
        _song(), Language.AUTO, threading.Event()
    )

    assert [(candidate.artist, candidate.lyrics) for candidate in candidates] == [("N.W.", LYRICS)]


def test_an_artist_alias_does_not_prevent_the_title_query_finding_a_strict_match() -> None:
    fetch = _Fetch(
        _row("alias", artist="N.W."), _row("good"), alias=_page(artist="N.W."), good=_page()
    )

    candidates = TekstPesenokLyricsProvider(fetch=fetch).search(
        _song(), Language.AUTO, threading.Event()
    )

    assert {candidate.artist for candidate in candidates} == {ARTIST, "N.W."}
    assert fetch.calls == [ARTIST + " " + TITLE, "alias", TITLE, "good"]


def test_an_alias_seen_in_both_queries_is_fetched_once() -> None:
    rows = _row("alias", artist="N.W.")
    fetch = _Fetch(rows, rows, alias=_page(artist="N.W."))

    assert (
        len(
            TekstPesenokLyricsProvider(fetch=fetch).search(
                _song(), Language.AUTO, threading.Event()
            )
        )
        == 1
    )
    assert fetch.calls.count("alias") == 1


@pytest.mark.parametrize("at", ["query", "page"])
def test_rate_limit_stops_all_further_requests(at) -> None:
    failure = urllib.error.HTTPError("u", 429, "busy", None, None)
    fetch = _Fetch(
        failure if at == "query" else _row("bad") + _row("good"), bad=failure, good=_page()
    )

    with pytest.raises(DependencyError) as raised:
        TekstPesenokLyricsProvider(fetch=fetch).search(_song(), Language.AUTO, threading.Event())

    assert raised.value.code == "ProviderRateLimited"
    assert fetch.calls == [ARTIST + " " + TITLE] + (["bad"] if at == "page" else [])


def test_failure_is_reported_when_no_candidate_survives() -> None:
    fetch = _Fetch(_row("bad"), bad=TimeoutError())

    with pytest.raises(DependencyError) as raised:
        TekstPesenokLyricsProvider(fetch=fetch).search(_song(), Language.AUTO, threading.Event())

    assert raised.value.code == "ProviderTimeout"


@pytest.mark.parametrize("cancel_during_search", [False, True])
def test_cancellation_prevents_candidate_requests(cancel_during_search) -> None:
    cancel = threading.Event()
    calls = []

    def fetch(url: str, timeout: float) -> str:
        calls.append(url)
        cancel.set()
        return _row("good")

    if not cancel_during_search:
        cancel.set()
    assert not TekstPesenokLyricsProvider(fetch=fetch).search(_song(), Language.AUTO, cancel)
    assert len(calls) == int(cancel_during_search)
