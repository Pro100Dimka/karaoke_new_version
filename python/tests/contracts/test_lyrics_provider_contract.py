from __future__ import annotations

import threading
from datetime import UTC, datetime

import pytest

from backend.domain_errors import DependencyError, DomainError
from backend.lyrics.ports import LyricsCandidate
from backend.lyrics.retry import RetryingLyricsProvider, RetryPolicy
from backend.songs.domain import Language, Song, SongStatus, SourceState
from tests.fakes import FakeLyricsProvider, FakeWaiter


def _song() -> Song:
    now = datetime(2026, 1, 1, tzinfo=UTC)
    return Song(
        "song",
        "Title",
        "Artist",
        "identity",
        SourceState.MANAGED,
        None,
        SongStatus.IMPORTED,
        1,
        2,
        now,
        now,
        duration=180.0,
    )


def _provider(
    outcomes: list[tuple[LyricsCandidate, ...] | DependencyError],
) -> RetryingLyricsProvider:
    return RetryingLyricsProvider(
        FakeLyricsProvider(outcomes),
        RetryPolicy(max_attempts=1, backoff_seconds=()),
        FakeWaiter(),
    )


def test_lyrics_provider_contract_valid_result() -> None:
    candidate = LyricsCandidate("lyrics", "Title", "Artist", 180.0, "fake-lyrics")

    result = _provider([(candidate,)]).search(_song(), Language.AUTO, threading.Event())

    assert result == (candidate,)


def test_lyrics_provider_contract_not_found() -> None:
    result = _provider([()]).search(_song(), Language.ENGLISH, threading.Event())

    assert result == ()


def test_lyrics_provider_contract_timeout() -> None:
    provider = _provider([DependencyError("ProviderTimeout", "timeout")])

    with pytest.raises(DependencyError) as error:
        provider.search(_song(), Language.UKRAINIAN, threading.Event())

    assert error.value.code == "ProviderTimeout"


def test_lyrics_provider_contract_invalid_payload() -> None:
    provider = _provider([DependencyError("ProviderMalformed", "invalid payload")])

    with pytest.raises(DependencyError) as error:
        provider.search(_song(), Language.RUSSIAN, threading.Event())

    assert error.value.code == "ProviderMalformed"


def test_lyrics_provider_contract_cancellation() -> None:
    cancel = threading.Event()
    cancel.set()

    with pytest.raises(DomainError) as error:
        _provider([()]).search(_song(), Language.AUTO, cancel)

    assert error.value.code == "ProviderCancelled"
