from __future__ import annotations

import threading
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Sequence

import pytest

from backend.domain_errors import DependencyError
from backend.infrastructure.sidecar_lyrics import LocalSidecarLyricsReader
from backend.lyrics.discovery import LyricsDiscovery, LyricsMatchPolicy
from backend.lyrics.ports import LyricLineTiming, LyricsCandidate
from backend.processing.compute_policy import ComputeDevice, ExecutionContext
from backend.songs.domain import Language, Song, SongStatus, SourceState
from tests.fakes import FakeAiProvider

TITLE = "Paper Lanterns"
ARTIST = "North Window"
LYRICS = (
    "Paper lanterns wander slowly above sleeping houses tonight\n"
    "River water carries silver stars beneath the wooden bridge\n"
    "We follow quiet footsteps until morning opens every door"
)


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


def _candidate(**changes) -> LyricsCandidate:
    return replace(LyricsCandidate(LYRICS, TITLE, "N.W.", 180.0, "catalogue"), **changes)


class _Provider:
    def __init__(
        self,
        candidates: Sequence[LyricsCandidate] | DependencyError,
        provider_id: str = "catalogue",
        cancel: threading.Event | None = None,
    ) -> None:
        self.provider_id = provider_id
        self.candidates = candidates
        self.calls = 0
        self.cancel = cancel

    def search(self, song: Song, language: Language, cancel: threading.Event):
        self.calls += 1
        if self.cancel is not None:
            self.cancel.set()
        if isinstance(self.candidates, DependencyError):
            raise self.candidates
        return self.candidates


def _discovery(*providers: _Provider) -> LyricsDiscovery:
    return LyricsDiscovery(LocalSidecarLyricsReader(), providers, LyricsMatchPolicy())


def test_alias_is_selected_only_after_raw_recognition_without_repeating_http() -> None:
    provider = _Provider([_candidate()])
    discovery = _discovery(provider)
    prepared = discovery.lookup(_song(), threading.Event(), True)
    assert prepared.found is None
    heard = LYRICS.replace("silver", "silvery")

    result = discovery.discover(
        _song(),
        Path("vocal.wav"),
        FakeAiProvider(),
        threading.Event(),
        online_enabled=True,
        execution=ExecutionContext(ComputeDevice.CPU, 1),
        prepared=replace(prepared, transcripts=(heard,)),
    )

    assert (result.lyrics, result.source) == (LYRICS, "catalogue")
    assert provider.calls == 1


def test_post_recognition_catalogue_and_cues_are_clean_before_alignment() -> None:
    decorated = LYRICS.replace("silver", "silver,").replace("\n", "!\n") + "..."
    hints = tuple(
        LyricLineTiming(10.0 * (index + 1), line)
        for index, line in enumerate(decorated.splitlines())
    )
    provider = _Provider([_candidate(lyrics=decorated, timing_hints=hints)])
    discovery = _discovery(provider)
    prepared = discovery.lookup(_song(), threading.Event(), True)
    assert prepared.found is None

    result = discovery.discover(
        _song(),
        Path("vocal.wav"),
        FakeAiProvider(),
        threading.Event(),
        online_enabled=True,
        execution=ExecutionContext(ComputeDevice.CPU, 1),
        prepared=replace(prepared, transcripts=(LYRICS,)),
    )

    assert result.lyrics == LYRICS
    assert tuple(hint.text for hint in result.timing_hints) == tuple(LYRICS.splitlines())
    assert tuple(hint.start for hint in result.timing_hints) == tuple(hint.start for hint in hints)
    assert provider.calls == 1


def test_rejected_initial_catalogue_reuses_results_and_searches_remaining_providers() -> None:
    wrong = _Provider(
        [_candidate(lyrics="Quiet mountains shelter distant forests", artist=ARTIST)], "wrong"
    )
    correct = _Provider([_candidate()], "catalogue")
    discovery = _discovery(wrong, correct)
    prepared = discovery.lookup(_song(), threading.Event(), True)
    assert prepared.found is not None and prepared.found.source == "wrong"
    assert correct.calls == 0

    result = discovery.discover(
        _song(),
        Path("vocal.wav"),
        FakeAiProvider(),
        threading.Event(),
        online_enabled=True,
        execution=ExecutionContext(ComputeDevice.CPU, 1),
        prepared=replace(prepared, transcripts=(LYRICS, "")),
    )

    assert (result.lyrics, result.source) == (LYRICS, "catalogue")
    assert "LyricsCatalogRejected" in result.warnings
    assert (wrong.calls, correct.calls) == (1, 1)


@pytest.mark.parametrize(
    "heard",
    [
        "",
        "Paper lanterns wander slowly",
        "la " * 30,
        "\n".join(reversed(LYRICS.splitlines())),
        LYRICS.splitlines()[0] * 4,
    ],
    ids=["empty", "too-short", "nonlexical", "wrong-order", "shared-chorus-only"],
)
def test_insufficient_performance_evidence_never_overrides_artist(heard) -> None:
    discovery = _discovery(_Provider([_candidate()]))

    assert discovery._from_online(_song(), threading.Event(), [], transcripts=(heard,)) is None


def test_repetition_does_not_supply_distinct_evidence() -> None:
    lyrics = "sing together through the night " * 8
    discovery = _discovery(_Provider([_candidate(lyrics=lyrics)]))

    assert discovery._from_online(_song(), threading.Event(), [], transcripts=(lyrics,)) is None


@pytest.mark.parametrize(
    "lyrics, accepted",
    [
        ("paper lantern river water silver morning wooden bridge paper lantern river water", True),
        ("paper lantern river water silver morning wooden bridge quiet houses tonight", False),
        ("paper lantern river water silver morning wooden paper lantern river water silver", False),
    ],
    ids=["adequate", "eleven-words", "seven-distinct-words"],
)
def test_positive_confirmation_keeps_the_existing_recognition_evidence_floor(
    lyrics, accepted
) -> None:
    discovery = _discovery(_Provider([_candidate(lyrics=lyrics)]))

    result = discovery._from_online(_song(), threading.Event(), [], transcripts=(lyrics,))

    assert (result is not None) is accepted


@pytest.mark.parametrize("changes", [{"title": "Midday Traffic"}, {"duration": 240.0}])
def test_strong_lyrics_cannot_override_title_or_duration(changes) -> None:
    discovery = _discovery(_Provider([_candidate(**changes)]))

    assert discovery._from_online(_song(), threading.Event(), [], transcripts=(LYRICS,)) is None


def test_later_provider_strict_artist_match_takes_priority() -> None:
    strict_lyrics = LYRICS.replace("silver", "golden")
    first = _Provider([_candidate()], "first")
    second = _Provider([_candidate(lyrics=strict_lyrics, artist=ARTIST)], "second")

    result = _discovery(first, second)._from_online(
        _song(), threading.Event(), [], transcripts=(LYRICS,)
    )

    assert result is not None
    assert (result.lyrics, result.source) == (strict_lyrics, "second")


@pytest.mark.parametrize("separate_providers", [False, True])
def test_different_strongly_supported_alias_texts_are_ambiguous(separate_providers) -> None:
    other = _candidate(lyrics=LYRICS.replace("silver", "golden"), artist="Another singer")
    providers = (
        [_Provider([_candidate()], "first"), _Provider([other], "second")]
        if separate_providers
        else [_Provider([_candidate(), other])]
    )

    assert (
        _discovery(*providers)._from_online(_song(), threading.Event(), [], transcripts=(LYRICS,))
        is None
    )


def test_equivalent_punctuation_and_case_do_not_create_ambiguity() -> None:
    other = _candidate(lyrics=LYRICS.upper() + "!", artist="Another spelling")
    discovery = _discovery(_Provider([_candidate(), other]))

    result = discovery._from_online(_song(), threading.Event(), [], transcripts=(LYRICS,))

    assert result is not None and result.lyrics == LYRICS


def test_unconfirmed_longer_version_cannot_replace_confirmed_alias() -> None:
    other = _candidate(
        lyrics=LYRICS + "\nStrangers gather somewhere far away with unfamiliar voices",
        artist="Other",
    )
    discovery = _discovery(_Provider([other, _candidate()]))

    result = discovery._from_online(_song(), threading.Event(), [], transcripts=(LYRICS,))

    assert result is not None and result.lyrics == LYRICS
    assert result.alternatives == (_candidate(),)


@pytest.mark.parametrize("heard", ["la", LYRICS])
def test_unrelated_alias_cannot_replace_strict_catalogue_after_recognition(heard) -> None:
    provider = _Provider(
        [
            _candidate(lyrics="Unrelated words"),
            _candidate(artist=ARTIST),
        ]
    )
    discovery = _discovery(provider)
    prepared = discovery.lookup(_song(), threading.Event(), True)

    result = discovery.discover(
        _song(),
        Path("vocal.wav"),
        FakeAiProvider(),
        threading.Event(),
        online_enabled=True,
        execution=ExecutionContext(ComputeDevice.CPU, 1),
        prepared=replace(prepared, transcripts=(heard, "")),
    )

    assert result.lyrics == LYRICS
    assert result.source == "catalogue"


def test_direct_post_recognition_lookup_preserves_strict_artist_with_weak_asr() -> None:
    discovery = _discovery(
        _Provider(
            [
                _candidate(lyrics="Unrelated words"),
                _candidate(artist=ARTIST),
            ]
        )
    )

    result = discovery._from_online(_song(), threading.Event(), [], transcripts=("la",))

    assert result is not None and result.lyrics == LYRICS


def test_strong_raw_evidence_can_select_full_alias_from_a_strict_partial_catalogue() -> None:
    partial = "\n".join(LYRICS.splitlines()[:2])
    provider = _Provider([_candidate(lyrics=partial, artist=ARTIST), _candidate()])
    discovery = _discovery(provider)
    prepared = discovery.lookup(_song(), threading.Event(), True)
    assert prepared.found is not None and prepared.found.lyrics == partial

    result = discovery.discover(
        _song(),
        Path("vocal.wav"),
        FakeAiProvider(),
        threading.Event(),
        online_enabled=True,
        execution=ExecutionContext(ComputeDevice.CPU, 1),
        prepared=replace(prepared, transcripts=(LYRICS, "")),
    )

    assert result.lyrics == LYRICS
    assert provider.calls == 1


def test_provider_results_are_scoped_to_one_lookup() -> None:
    provider = _Provider([_candidate()])
    discovery = _discovery(provider)
    first = discovery.lookup(_song(), threading.Event(), True)
    other_song = replace(_song(), song_id="another", title="Morning Windows")
    provider.candidates = [
        _candidate(title=other_song.title, lyrics=LYRICS.replace("silver", "golden"))
    ]
    second = discovery.lookup(other_song, threading.Event(), True)

    assert provider.calls == 2
    assert first.online_candidates != second.online_candidates


def test_rate_limited_provider_is_not_retried_after_recognition() -> None:
    provider = _Provider(DependencyError("ProviderRateLimited", "busy"))
    discovery = _discovery(provider)
    prepared = discovery.lookup(_song(), threading.Event(), True)

    result = discovery.discover(
        _song(),
        Path("vocal.wav"),
        FakeAiProvider(),
        threading.Event(),
        online_enabled=True,
        execution=ExecutionContext(ComputeDevice.CPU, 1),
        prepared=replace(prepared, transcripts=(LYRICS,)),
    )

    assert result.source == "ASR"
    assert result.warnings == ("catalogue:ProviderRateLimited",)
    assert provider.calls == 1


@pytest.mark.parametrize("when", ["before", "during"])
def test_cancellation_stops_search_and_confirmation(when) -> None:
    cancel = threading.Event()
    first = _Provider([_candidate()], cancel=cancel if when == "during" else None)
    second = _Provider([_candidate()], "second")
    if when == "before":
        cancel.set()

    assert (
        _discovery(first, second)._from_online(_song(), cancel, [], transcripts=(LYRICS,)) is None
    )
    assert first.calls == int(when == "during")
    assert second.calls == 0


@pytest.mark.parametrize("source", ["sidecar", "embedded"])
def test_local_sources_are_preserved_and_do_not_search_catalogues(tmp_path, source) -> None:
    audio = tmp_path / "song.wav"
    song = replace(_song(), source_path=audio)
    text = "Local words chosen for this performance"
    if source == "sidecar":
        audio.with_suffix(".txt").write_text(text)
    else:
        song = replace(song, embedded_lyrics=text)
    provider = _Provider([_candidate()])
    discovery = _discovery(provider)
    prepared = discovery.lookup(song, threading.Event(), True)

    result = discovery.discover(
        song,
        Path("vocal.wav"),
        FakeAiProvider(),
        threading.Event(),
        online_enabled=True,
        execution=ExecutionContext(ComputeDevice.CPU, 1),
        prepared=replace(prepared, transcripts=(LYRICS, "")),
    )

    assert result.lyrics == text
    assert result.source == ("LocalSidecar" if source == "sidecar" else "EmbeddedLyrics")
    assert provider.calls == 0
