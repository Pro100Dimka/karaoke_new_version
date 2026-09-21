from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Protocol, Sequence

from backend.domain_errors import DependencyError, DomainError
from backend.lyrics.ports import LyricsCandidate, OnlineLyricsProvider
from backend.songs.domain import Language, Song


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    max_attempts: int = 3
    backoff_seconds: tuple[float, ...] = (0.1, 0.5)

    def __post_init__(self) -> None:
        if self.max_attempts < 1:
            raise ValueError("max_attempts must be positive")


class Waiter(Protocol):
    def wait(self, seconds: float, cancel: threading.Event) -> bool: ...


class CancelAwareWaiter:
    def wait(self, seconds: float, cancel: threading.Event) -> bool:
        return cancel.wait(seconds)


class RetryingLyricsProvider:
    def __init__(
        self,
        provider: OnlineLyricsProvider,
        policy: RetryPolicy,
        waiter: Waiter,
    ) -> None:
        self._provider = provider
        self._policy = policy
        self._waiter = waiter

    @property
    def provider_id(self) -> str:
        return self._provider.provider_id

    def search(
        self,
        song: Song,
        language: Language,
        cancel: threading.Event,
    ) -> Sequence[LyricsCandidate]:
        last_error: DomainError | None = None
        for attempt in range(self._policy.max_attempts):
            if cancel.is_set():
                raise DomainError("ProviderCancelled", "Lyrics provider request was cancelled", 499)
            try:
                return self._provider.search(song, language, cancel)
            except DependencyError as exc:
                last_error = exc
                if not _retryable(exc) or attempt + 1 >= self._policy.max_attempts:
                    break
                delay = self._delay(attempt)
                if self._waiter.wait(delay, cancel):
                    raise DomainError(
                        "ProviderCancelled", "Lyrics provider request was cancelled", 499
                    )
        if last_error:
            raise last_error
        return ()

    def _delay(self, attempt: int) -> float:
        if not self._policy.backoff_seconds:
            return 0.0
        index = min(attempt, len(self._policy.backoff_seconds) - 1)
        return self._policy.backoff_seconds[index]


def _retryable(error: DependencyError) -> bool:
    return error.code in {"ProviderTimeout", "ProviderRateLimited", "ProviderUnavailable"}
