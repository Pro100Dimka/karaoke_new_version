from __future__ import annotations

import threading
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Sequence

from backend.domain_errors import DependencyError
from backend.lyrics.phrases import (
    _catalog_matches_performance,
    _lyrics_key,
    _lyrics_match,
    _same_vocabulary,
)
from backend.lyrics.ports import LyricsCandidate, OnlineLyricsProvider
from backend.songs.domain import Song
from backend.songs.filename_metadata import UNKNOWN_ARTIST
from backend.text_normalization import (
    clean_lyrics,
    normalize_catalog_identity,
    split_artist_credit,
    strip_annotations,
)

type CatalogueCache = dict[int, tuple[LyricsCandidate, ...]]


@dataclass(frozen=True, slots=True)
class LyricsMatchPolicy:
    duration_tolerance_seconds: float = 8.0
    duration_tolerance_fraction: float = 0.10


@dataclass(frozen=True, slots=True)
class CatalogueSelection:
    candidates: tuple[LyricsCandidate, ...]
    matched: LyricsCandidate
    source: str


def select_catalogue(
    providers: Sequence[OnlineLyricsProvider],
    song: Song,
    policy: LyricsMatchPolicy,
    cancel: threading.Event,
    warnings: list[str],
    cache: CatalogueCache,
    transcripts: Sequence[str],
) -> CatalogueSelection | None:
    aliases: dict[LyricsCandidate, str] = {}
    for index, provider in enumerate(providers):
        if cancel.is_set():
            return None
        candidates = cached_candidates(provider, index, song, cancel, warnings, cache)
        if cancel.is_set():
            return None
        eligible = tuple(
            item
            for item in candidates
            if matches_metadata(song, item, policy, check_artist=False)
            and _catalog_matches_performance(item.lyrics, transcripts)
        )
        matched = next((item for item in eligible if matches_metadata(song, item, policy)), None)
        if matched is None:
            # A solo lead credit needs an equivalent catalogue entry crediting the guests.
            artists = tuple(map(normalize_catalog_identity, split_artist_credit(song.artist)))
            title = normalize_catalog_identity(strip_annotations(song.title))
            matched = next(
                (
                    item
                    for item in eligible
                    if len(artists) > 1
                    and all(artists)
                    and song.duration is not None
                    and item.duration is not None
                    and len(split_artist_credit(item.artist)) == 1
                    and normalize_catalog_identity(strip_annotations(item.artist)) == artists[0]
                    and normalize_catalog_identity(strip_annotations(item.title)) == title
                    and any(
                        other != item
                        and other.duration is not None
                        and normalize_catalog_identity(strip_annotations(other.title)) == title
                        and _words(other.lyrics) == _words(item.lyrics)
                        and set(artists[1:]).issubset(
                            map(normalize_catalog_identity, split_artist_credit(other.artist))
                        )
                        for other in eligible
                    )
                ),
                None,
            )
        if matched:
            if transcripts:
                eligible = tuple(
                    item
                    for item in eligible
                    if supported_alternative(song, item, matched.lyrics, policy, transcripts)
                )
            return CatalogueSelection(eligible, matched, provider.provider_id)
        aliases.update((item, provider.provider_id) for item in eligible)
    confirmed = confirmed_catalogue(tuple(aliases), transcripts)
    return CatalogueSelection((confirmed,), confirmed, aliases[confirmed]) if confirmed else None


def cached_candidates(
    provider: OnlineLyricsProvider,
    index: int,
    song: Song,
    cancel: threading.Event,
    warnings: list[str],
    cache: CatalogueCache,
) -> tuple[LyricsCandidate, ...]:
    if index not in cache:
        try:
            cache[index] = tuple(provider.search(song, song.language, cancel))
        except DependencyError as exc:
            warnings.append(f"{provider.provider_id}:{exc.code}")
            # A post-recognition lookup must not repeat an outage or rate-limited request.
            cache[index] = ()
    return cache[index]


def matches_metadata(
    song: Song,
    candidate: LyricsCandidate,
    policy: LyricsMatchPolicy,
    *,
    check_artist: bool = True,
) -> bool:
    if not _similar(song.title, candidate.title):
        return False
    if (
        check_artist
        and song.artist != UNKNOWN_ARTIST
        and not _similar(song.artist, candidate.artist)
    ):
        return False
    if song.duration is None or candidate.duration is None:
        return True
    tolerance = max(
        policy.duration_tolerance_seconds, song.duration * policy.duration_tolerance_fraction
    )
    return abs(song.duration - candidate.duration) <= tolerance


def _similar(expected: str, actual: str) -> bool:
    left = normalize_catalog_identity(strip_annotations(expected))
    right = normalize_catalog_identity(strip_annotations(actual))
    return bool(left) and bool(right) and SequenceMatcher(None, left, right).ratio() >= 0.84


def confirmed_catalogue(
    candidates: Sequence[LyricsCandidate], transcripts: Sequence[str]
) -> LyricsCandidate | None:
    """Confirm a unique whole text using raw recognition, never the permissive rejection gate."""
    heard = [
        words
        for transcript in transcripts
        if len(words := _words(transcript)) >= 12
        and len({word for word in words if len(word) >= 3}) >= 8
    ]
    confirmed: dict[tuple[str, ...], LyricsCandidate] = {}
    for candidate in candidates:
        words = _words(candidate.lyrics)
        if any(_lyrics_match(" ".join(words), " ".join(actual)) for actual in heard):
            confirmed.setdefault(words, candidate)
    # Similar verses from different recordings are not interchangeable without an artist match.
    return next(iter(confirmed.values())) if len(confirmed) == 1 else None


def supported_alternative(
    song: Song,
    candidate: LyricsCandidate,
    baseline: str,
    policy: LyricsMatchPolicy,
    transcripts: Sequence[str],
) -> bool:
    return (
        matches_metadata(song, candidate, policy)
        or _same_vocabulary(baseline, candidate.lyrics)
        or confirmed_catalogue((candidate,), transcripts) is not None
    )


def _words(text: str) -> tuple[str, ...]:
    return tuple(key for word in clean_lyrics(text, "Auto").split() if (key := _lyrics_key(word)))
