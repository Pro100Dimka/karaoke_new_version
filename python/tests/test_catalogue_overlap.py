from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
import threading

import pytest

from backend.infrastructure.sidecar_lyrics import LocalSidecarLyricsReader
from backend.lyrics.discovery import LyricsDiscovery, LyricsMatchPolicy
from backend.lyrics.catalogue_versions import reconcile_timed_overlaps
from backend.lyrics.phrases import _lyrics_key
from backend.lyrics.ports import LyricLineTiming, LyricsCandidate
from backend.processing.compute_policy import ComputeDevice, ExecutionContext
from backend.songs.domain import Song, SongStatus, SourceState


_PREFIX = "Hold me close hold me close"
_FRAGMENT = "Hold me close until dawn"
_FULL = f"{_PREFIX} {_FRAGMENT.lower()} in rain"
_VERSE = "Silver rivers carry every fading memory home"
_OUTRO = "Morning lanterns guide us safely through the storm"


def _case():
    lines = [_FULL] * 4 + [_FRAGMENT, _VERSE, _OUTRO, _FULL, _FULL]
    starts = [0, 6.5, 13, 19.5, 22.5, 25.5, 32, 40, 46.5]
    original = LyricsCandidate(
        "\n".join(lines),
        "Song",
        "Artist",
        180,
        "catalogue",
        tuple(LyricLineTiming(start, line) for start, line in zip(starts, lines)),
    )
    alternate = replace(
        original,
        lyrics="\n".join([_FULL] * 3 + [_PREFIX, _FRAGMENT, _VERSE]),
        duration=183,
        timing_hints=(),
    )
    # Recognition missed the first repeated opening, but positively heard the
    # retained prefix, complete following fragment and distinct verse together.
    heard = " ".join([_FULL] * 3 + ["hold me close", _FRAGMENT, _VERSE, _OUTRO])
    return original, alternate, heard


def _select(original, alternatives, transcripts):
    now = datetime(2026, 1, 1, tzinfo=UTC)
    song = Song(
        "song",
        "Song",
        "Artist",
        "audio",
        SourceState.MANAGED,
        None,
        SongStatus.IMPORTED,
        1,
        2,
        now,
        now,
        duration=180,
    )

    class Provider:
        provider_id = "catalogue"

        def search(self, *_args):
            return [original, *alternatives]

    class NoInference:
        def transcribe(self, *_args, **_kwargs):
            raise AssertionError("The replay must use captured recognition")

    discovery = LyricsDiscovery(LocalSidecarLyricsReader(), (Provider(),), LyricsMatchPolicy())
    prepared = discovery.lookup(song, threading.Event(), True)
    return discovery.discover(
        song,
        Path("vocals.wav"),
        NoInference(),
        threading.Event(),
        online_enabled=True,
        execution=ExecutionContext(ComputeDevice.CPU, 1),
        prepared=replace(prepared, transcripts=tuple(transcripts) + (("",) if transcripts else ())),
        original_audio=Path(__file__) if len(transcripts) > 1 else None,
    )


def test_corroborated_overlapping_cue_keeps_the_prefix_and_other_version_outro():
    original, alternate, heard = _case()
    actual = _select(original, [alternate], [heard])
    expected = original.lyrics.splitlines()
    expected[3] = _PREFIX

    assert actual.lyrics.splitlines() == expected
    assert [hint.start for hint in actual.timing_hints] == [
        hint.start for hint in original.timing_hints
    ]
    assert [hint.text for hint in actual.timing_hints] == expected


@pytest.mark.parametrize("missing", ["recognition", "alternate", "prefix", "next_verse"])
def test_overlap_requires_the_exact_supported_catalogue_counterpart(missing):
    original, alternate, heard = _case()
    if missing == "prefix":
        alternate = replace(
            alternate, lyrics=alternate.lyrics.replace(_PREFIX + "\n", "Fly away\n")
        )
    if missing == "next_verse":
        alternate = replace(alternate, lyrics=alternate.lyrics.replace(_VERSE, "Another verse"))
    actual = _select(
        original,
        [] if missing == "alternate" else [alternate],
        [] if missing == "recognition" else [heard],
    )
    assert actual.lyrics == original.lyrics
    assert actual.timing_hints == original.timing_hints


def test_a_positive_complete_occurrence_vetoes_shortening_even_with_another_missed_view():
    original, alternate, heard = _case()
    actual = _select(original, [alternate], [heard, original.lyrics])
    assert actual.lyrics == original.lyrics


def test_a_differently_paced_cue_is_not_treated_as_a_duplicate_fragment():
    original, alternate, heard = _case()
    hints = list(original.timing_hints)
    hints[4] = replace(hints[4], start=24)
    original = replace(original, timing_hints=tuple(hints))
    assert _select(original, [alternate], [heard]).lyrics == original.lyrics


@pytest.mark.parametrize("fragment_start", [29.9, 30.0])
def test_non_increasing_cues_cannot_shorten_a_very_long_line(fragment_start):
    prefix = "Hold me close"
    full = " ".join([prefix, _FRAGMENT, *(["echo"] * 92)])
    lines = [full] * 4 + [_FRAGMENT, _VERSE]
    original = LyricsCandidate(
        "\n".join(lines),
        "Song",
        "Artist",
        180,
        "catalogue",
        tuple(
            LyricLineTiming(start, line)
            for start, line in zip([0, 10, 20, 30, fragment_start, 40], lines)
        ),
    )
    alternate = replace(original, lyrics="\n".join([prefix, _FRAGMENT, _VERSE]))
    heard = " ".join([prefix, _FRAGMENT, _VERSE])

    assert reconcile_timed_overlaps(original, [alternate], [heard], _lyrics_key) is original


def test_two_consistent_full_cues_cannot_establish_the_shortening_ratio():
    original, alternate, heard = _case()
    hints = list(original.timing_hints)
    hints[1] = replace(hints[1], start=8)
    original = replace(original, timing_hints=tuple(hints))
    assert _select(original, [alternate], [heard]).lyrics == original.lyrics


def test_capitalization_of_the_same_alternate_prefix_is_not_another_variant():
    original, alternate, heard = _case()
    equivalent = replace(alternate, lyrics=alternate.lyrics.upper())
    actual = _select(original, [alternate, equivalent], [heard])
    expected = original.lyrics.splitlines()
    expected[3] = _PREFIX
    assert actual.lyrics.splitlines() == expected


def test_a_standalone_repeated_fragment_makes_the_occurrence_ambiguous():
    original, alternate, heard = _case()
    original = replace(
        original,
        lyrics=original.lyrics + "\n" + _FRAGMENT,
        timing_hints=(*original.timing_hints, LyricLineTiming(53, _FRAGMENT)),
    )
    assert _select(original, [alternate], [heard]).lyrics == original.lyrics
