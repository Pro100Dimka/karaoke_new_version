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


@pytest.mark.parametrize("confirmed", [False, True])
def test_short_timed_repeat_can_be_confirmed_by_a_local_audio_window(confirmed):
    original, _alternate, heard = _case()
    calls = []

    def recognize(start, end):
        calls.append((start, end))
        return (heard,) if confirmed else ("hold me close",)

    actual = reconcile_timed_overlaps(
        original, [], ["the full recording missed the repeat"], _lyrics_key, recognize
    )
    expected = original.lyrics.splitlines()
    if confirmed:
        expected[3] = _PREFIX
    assert actual.lyrics.splitlines() == expected
    assert [hint.text for hint in actual.timing_hints] == expected
    assert len(calls) == 1 and calls[0][0] < 19.5 < 25.5 < calls[0][1]


@pytest.mark.parametrize("complete", [False, True])
def test_local_cue_allows_a_missed_connective_but_never_removes_a_complete_repeat(complete):
    original, _alternate, _heard = _case()
    verse = "Горит и рвётся умирает суета и бред"
    original = replace(
        original,
        lyrics=original.lyrics.replace(_VERSE, verse),
        timing_hints=tuple(
            replace(hint, text=verse) if hint.text == _VERSE else hint
            for hint in original.timing_hints
        ),
    )
    heard = f"{_FULL if complete else _PREFIX} {_FRAGMENT} горит рвется умирает"
    actual = reconcile_timed_overlaps(original, [], ["unrelated"], _lyrics_key, lambda *_: (heard,))
    assert actual.lyrics.splitlines()[3] == (_FULL if complete else _PREFIX)


@pytest.mark.parametrize("surplus_supported", [False, True])
def test_repeat_verification_preserves_the_reconciled_catalogue_floor(surplus_supported):
    from backend.ai.domain import WordTiming
    from backend.processing.document_pipeline import _verified_repeats

    original, alternate, heard = _case()
    # Recognition suggests surplus repetitions, so completion drops their ambiguous cues.
    found = _select(original, [alternate], [" ".join([heard, *([_FULL] * 4)])])
    baseline = original.lyrics.splitlines()
    baseline[3] = _PREFIX
    assert found.repeat_baseline.splitlines() == baseline
    assert [hint.text for hint in found.repeat_baseline_hints] == baseline
    assert found.lyrics.splitlines()[3] == _PREFIX
    words = tuple(
        WordTiming(text, index, index + 0.5, 0.8 if surplus_supported else 0.02)
        for index, text in enumerate(found.lyrics.split())
    )

    verified = _verified_repeats(found, words)

    assert verified.lyrics == (found.lyrics if surplus_supported else "\n".join(baseline))
    if not surplus_supported:
        assert verified.timing_hints == found.repeat_baseline_hints


@pytest.mark.parametrize(
    "diagnostic", ["BoundaryClipped", "BoundaryConflict", "ApproximateAlignment"]
)
@pytest.mark.parametrize("recognized", [False, True])
def test_clipped_repeat_entry_needs_independent_recognition(diagnostic, recognized):
    from backend.ai.domain import WordTiming
    from backend.lyrics.discovery import LyricsDiscoveryResult
    from backend.processing.document_pipeline import _verified_repeats

    phrase = "Hold me close until dawn"
    expanded = f"{phrase}\n{phrase}"
    discovery = LyricsDiscoveryResult(expanded, "catalogue", (), repeat_baseline=phrase)
    words = tuple(
        WordTiming(
            text,
            index,
            index + 0.5,
            0.8,
            diagnostics=(diagnostic, *(["RecognizedWord"] if recognized else []))
            if index == len(phrase.split())
            else (),
        )
        for index, text in enumerate(expanded.split())
    )

    result = _verified_repeats(discovery, words)

    assert result.lyrics == (expanded if recognized else phrase)


@pytest.mark.parametrize(
    "catalogue,performed,expected",
    [
        ([0, 0, 0, 1, 2], [0, 1, 0, 1, 2], [0, 0, 0, 1, 2]),
        ([0, 0, 0, 1, 2], [0, 0, 0, 1, 1, 2], [0, 0, 0, 1, 1, 2]),
        ([0, 0, 0, 1, 2], [0, 1, 0, 1, 1, 2], [0, 0, 0, 1, 1, 2]),
        ([0, 0, 0, 1, 2], [0, 1, 1, 0, 1, 2], [0, 0, 1, 0, 1, 2]),
        ([0, 0, 1, 2, 0], [0, 1, 0, 1, 2], [0, 1, 0, 1, 2, 0]),
    ],
)
def test_a_partial_catalogue_occurrence_does_not_invent_or_consume_an_extra_prefix(
    catalogue, performed, expected
):
    from backend.lyrics.phrases import _complete_repeats

    phrases = [
        "We hold the light while distant rivers slowly return home",
        "We hold the light",
        "Silver mountains carry every fading memory home",
    ]
    actual = _complete_repeats(
        "\n".join(phrases[i] for i in catalogue),
        " ".join(phrases[i] for i in performed),
        threading.Event(),
    )

    assert actual.splitlines() == [phrases[i] for i in expected]


@pytest.mark.parametrize("short", ["We hold", "We hold the light"])
def test_ambiguous_or_incomplete_word_prefix_does_not_absorb_an_extra_occurrence(short):
    from backend.lyrics.phrases import _complete_repeats

    full = "We hold the lighthouse while distant rivers slowly return home"
    verse = "Silver mountains carry every fading memory home"
    catalogue = [full, full, full, short, verse]
    performed = [full, short, full, short, verse]

    actual = _complete_repeats("\n".join(catalogue), " ".join(performed), threading.Event())

    assert actual.splitlines().count(full) == 3
    assert actual.splitlines().count(short) == 2


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
