from __future__ import annotations

import threading
from datetime import UTC, datetime

import pytest

from backend.domain_errors import DependencyError, DomainError
from backend.lyrics.ports import LyricsCandidate
from backend.lyrics.retry import RetryingLyricsProvider, RetryPolicy
from backend.songs.domain import Language, Song, SongStatus, SourceState
from tests.fakes import FakeLyricsProvider, FakeWaiter


def song() -> Song:
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


def test_retry_succeeds_after_transient_failure_without_real_sleep() -> None:
    candidate = LyricsCandidate("lyrics", "Title", "Artist", 180.0, "provider")
    provider = FakeLyricsProvider([DependencyError("ProviderTimeout", "timeout"), (candidate,)])
    waiter = FakeWaiter()
    retrying = RetryingLyricsProvider(provider, RetryPolicy(3, (0.25, 0.5)), waiter)

    result = retrying.search(song(), Language.AUTO, threading.Event())

    assert result == (candidate,)
    assert waiter.delays == [0.25]


def test_retry_stops_at_max_attempts() -> None:
    provider = FakeLyricsProvider(
        [
            DependencyError("ProviderUnavailable", "down"),
            DependencyError("ProviderUnavailable", "down"),
            DependencyError("ProviderUnavailable", "down"),
        ]
    )
    waiter = FakeWaiter()
    retrying = RetryingLyricsProvider(provider, RetryPolicy(3, (0.1, 0.2)), waiter)

    with pytest.raises(DependencyError) as error:
        retrying.search(song(), Language.AUTO, threading.Event())

    assert error.value.code == "ProviderUnavailable"
    assert waiter.delays == [0.1, 0.2]


def test_non_retryable_provider_error_is_terminal() -> None:
    provider = FakeLyricsProvider([DependencyError("ProviderMalformed", "bad")])
    waiter = FakeWaiter()
    retrying = RetryingLyricsProvider(provider, RetryPolicy(), waiter)

    with pytest.raises(DependencyError) as error:
        retrying.search(song(), Language.AUTO, threading.Event())

    assert error.value.code == "ProviderMalformed"
    assert waiter.delays == []


def test_cancel_is_checked_before_provider_call() -> None:
    provider = FakeLyricsProvider([()])
    cancel = threading.Event()
    cancel.set()

    with pytest.raises(DomainError) as error:
        RetryingLyricsProvider(provider, RetryPolicy(), FakeWaiter()).search(
            song(), Language.AUTO, cancel
        )

    assert error.value.code == "ProviderCancelled"


def test_rate_limit_is_retryable_without_sleep() -> None:
    candidate = LyricsCandidate("lyrics", "Title", "Artist", 180.0, "provider")
    provider = FakeLyricsProvider(
        [DependencyError("ProviderRateLimited", "rate limited"), (candidate,)]
    )
    waiter = FakeWaiter()
    retrying = RetryingLyricsProvider(provider, RetryPolicy(2, (0.4,)), waiter)

    result = retrying.search(song(), Language.AUTO, threading.Event())

    assert result == (candidate,)
    assert waiter.delays == [0.4]
