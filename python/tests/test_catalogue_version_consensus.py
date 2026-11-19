from __future__ import annotations

import pytest

from backend.lyrics.phrases import _best_catalog_version
from backend.lyrics.ports import LyricsCandidate


_SHARED = (
    "Silver lanterns shine above the empty station\nMorning trains return across the distant valley"
)
_SUNG = "Please call me after midnight"
_OTHER = "Please call me before sunrise"
_NOISE = "uncertain cloudy echoes broken whispers fading unheard wandering sounds"


def _candidate(verse: str, duration: float) -> LyricsCandidate:
    return LyricsCandidate(f"{_SHARED}\n{verse}", "Song", "Artist", duration, "catalog")


def _heard(verse: str) -> str:
    return f"{_SHARED} {verse} {_NOISE}"


@pytest.mark.parametrize("reverse", [False, True])
def test_two_full_views_confirm_the_performed_verse_despite_unrelated_recognition_noise(reverse):
    performed, other = _candidate(_SUNG, 181), _candidate(_OTHER, 180)
    candidates = [performed, other] if reverse else [other, performed]
    transcripts = [_heard(_SUNG), _heard(_SUNG).replace("lanterns", "lantern")]

    assert _best_catalog_version(candidates, {performed: 1, other: 0}, transcripts) == performed


def test_one_noisy_full_view_does_not_override_the_recording_duration():
    performed, other = _candidate(_SUNG, 181), _candidate(_OTHER, 180)

    assert (
        _best_catalog_version([other, performed], {performed: 1, other: 0}, [_heard(_SUNG)])
        == other
    )


def test_conflicting_full_views_keep_the_existing_duration_preference():
    performed, other = _candidate(_SUNG, 181), _candidate(_OTHER, 180)

    assert (
        _best_catalog_version(
            [other, performed], {performed: 1, other: 0}, [_heard(_SUNG), _heard(_OTHER)]
        )
        == other
    )


def test_a_short_repeated_recognition_cannot_supply_the_second_full_view():
    performed, other = _candidate(_SUNG, 181), _candidate(_OTHER, 180)

    assert (
        _best_catalog_version(
            [other, performed], {performed: 1, other: 0}, [_heard(_SUNG), "call me " * 6]
        )
        == other
    )


def test_more_catalogue_words_cannot_win_consensus_by_covering_more_recognition_noise():
    short = _candidate(_SUNG, 180)
    long = _candidate(f"{_SUNG}\nThank you everyone", 181)
    heard = f"{_heard(_SUNG)} Thank you"

    assert _best_catalog_version([long, short], {short: 0, long: 1}, [heard, heard]) == short


def test_agreement_on_one_misheard_word_cannot_remove_a_quiet_unrecognized_line():
    quiet = "Footsteps linger softly beyond distant doors until daylight"
    complete = _candidate(f"{_SUNG}\n{quiet}", 180)
    shortened = _candidate(_SUNG.replace("midnight", "sunrise"), 175)
    heard = _heard(_SUNG.replace("midnight", "sunrise"))

    assert (
        _best_catalog_version(
            [shortened, complete],
            {complete: 0, shortened: 5},
            [heard, heard.replace("lanterns", "lantern")],
        )
        == complete
    )


@pytest.mark.parametrize("quiet", ["Silver", "Silver lanterns", "Silver lanterns shine"])
def test_a_quiet_prefix_cannot_borrow_words_from_the_next_retained_line(quiet):
    complete = LyricsCandidate(f"{quiet}\n{_SHARED}\n{_SUNG}", "Song", "Artist", 180, "catalog")
    shortened = _candidate(_SUNG.replace("midnight", "sunrise"), 175)
    heard = _heard(_SUNG.replace("midnight", "sunrise"))

    assert (
        _best_catalog_version(
            [shortened, complete],
            {complete: 0, shortened: 5},
            [heard, heard.replace("lanterns", "lantern")],
        )
        == complete
    )


def test_unrelated_verse_replacement_keeps_the_existing_duration_choice():
    performed = _candidate(_SUNG, 181)
    unrelated = _candidate("Find a place beside the ocean", 180)
    heard = _heard(_SUNG)

    assert (
        _best_catalog_version([unrelated, performed], {performed: 1, unrelated: 0}, [heard, heard])
        == unrelated
    )


@pytest.mark.parametrize("last_support,retained", [(3, False), (4, True)])
def test_an_equally_supported_path_that_skips_a_line_vetoes_replacement(last_support, retained):
    from backend.lyrics.catalogue_versions import _preserved_lines

    def matches(key, _words, start):
        if key == "first" and start == 0:
            return iter([(1, 3)])
        if key == "second":
            return iter([(2, 6 if start == 0 else last_support)])
        return iter(())

    # Keeping both lines scores 3 + last_support; skipping the first scores 6.
    # Equal support cannot prove that an unheard line may disappear.
    path = _preserved_lines([["first"], ["second"]], ["alpha", "beta"], matches)

    assert (path is not None) is retained


def test_an_equally_supported_native_span_that_keeps_the_original_vetoes_replacement():
    from backend.lyrics.catalogue_versions import _positive_counterpart
    from backend.lyrics.phrases import _line_matches

    # Both "park night" and "dark light" score seven against "dark night".
    # The last span favors the replacement, but the first exactly preserves the original.
    heard = ["park", "night", "dark", "light"]

    assert not _positive_counterpart(
        ["park", "night"], ["dark", "night"], [heard, heard], _line_matches
    )


def test_without_recognition_the_existing_duration_choice_is_unchanged():
    performed, other = _candidate(_SUNG, 181), _candidate(_OTHER, 180)

    assert _best_catalog_version([performed, other], {performed: 1, other: 0}, []) == other
