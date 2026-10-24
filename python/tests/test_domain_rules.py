from __future__ import annotations

from datetime import UTC, datetime
from dataclasses import replace

import pytest

from backend.lyrics.domain import LyricsDocument, Note, Word
from backend.lyrics.codec import decode_document, encode_document
from backend.processing.cache_key import CacheIdentity, build_cache_key
from backend.processing.domain import Job, JobState, JobType
from backend.processing.policies import ResourceBudget


def test_isolated_rhythm_survives_document_serialization_and_rejects_invalid_points():
    document = LyricsDocument("Song", "Artist", 3, None, None, "", (), rhythm=((0.5, 1), (2, 0.4)))
    assert decode_document(encode_document(document)).rhythm == document.rhythm
    for rhythm in [((4, 1),), ((1, 2),), ((2, 1), (1, 1))]:
        with pytest.raises(ValueError, match="Rhythm"):
            replace(document, rhythm=rhythm).validate()


def test_note_must_stay_inside_word() -> None:
    word = Word("la", 1.0, 2.0, (Note(60, 0.9, 1.5),))

    with pytest.raises(ValueError, match="inside its word"):
        word.validate()


def test_overlapping_notes_are_rejected() -> None:
    word = Word(
        "la",
        0.0,
        1.0,
        (Note(60, 0.1, 0.6), Note(62, 0.5, 0.9)),
    )

    with pytest.raises(ValueError, match="Overlapping notes"):
        word.validate()


def test_words_must_be_ordered() -> None:
    document = LyricsDocument(
        "Title",
        "Artist",
        2.0,
        None,
        None,
        "a b",
        (Word("a", 1.0, 1.5, ()), Word("b", 0.5, 0.9, ())),
    )

    with pytest.raises(ValueError, match="ordered"):
        document.validate()


@pytest.mark.parametrize("duration", [float("nan"), float("inf"), float("-inf")])
def test_lyrics_duration_must_be_finite(duration: float) -> None:
    with pytest.raises(ValueError):
        LyricsDocument("Title", "Artist", duration, None, None, "", ()).validate()


@pytest.mark.parametrize(
    "start,end", [(-0.1, 0.5), (1.5, 2.1), (float("nan"), 1.0), (0.0, float("inf"))]
)
def test_word_timing_must_stay_on_the_finite_song_timeline(start: float, end: float) -> None:
    document = LyricsDocument(
        "Title", "Artist", 2.0, None, None, "la", (Word("la", start, end, ()),)
    )
    with pytest.raises(ValueError):
        document.validate()


@pytest.mark.parametrize("field", ["start", "end"])
@pytest.mark.parametrize("moment", [float("nan"), float("inf"), float("-inf")])
def test_note_timing_must_be_finite(field: str, moment: float) -> None:
    note = replace(Note(60, 1.0, 1.5), **{field: moment})
    with pytest.raises(ValueError):
        Word("la", 1.0, 2.0, (note,)).validate()


@pytest.mark.parametrize(
    "letters", [(0.5, 1.5), (1.0, 2.5), (1.0, float("nan")), (1.0, float("inf"))]
)
def test_letter_timing_must_stay_inside_its_word(letters: tuple[float, ...]) -> None:
    with pytest.raises(ValueError):
        Word("la", 1.0, 2.0, (), letters).validate()


def test_timeline_validation_preserves_melismas_and_boundary_letters() -> None:
    word = Word("la", 0.0, 2.0, (Note(60, 0.0, 0.5), Note(64, 0.5, 2.0)), (0.0, 2.0))
    document = LyricsDocument("Title", "Artist", 2.0, None, None, "la", (word,))
    document.validate()
    assert document.words == (word,)


def test_job_state_machine_rejects_invalid_transition() -> None:
    now = datetime(2026, 1, 1, tzinfo=UTC)
    job = Job("j", JobType.SONG_PROCESSING, JobState.QUEUED, now, now)

    with pytest.raises(ValueError, match="Invalid job transition"):
        job.transition(JobState.SUCCEEDED, now)


def test_job_transition_sets_started_and_finished_timestamps() -> None:
    now = datetime(2026, 1, 1, tzinfo=UTC)
    job = Job("j", JobType.SONG_PROCESSING, JobState.QUEUED, now, now)

    running = job.transition(JobState.RUNNING, now)
    succeeded = running.transition(JobState.SUCCEEDED, now)

    assert running.started_at == now
    assert succeeded.finished_at == now
    assert succeeded.terminal is True


def test_cache_key_is_stable_for_parameter_order() -> None:
    left = CacheIdentity("input", "model", "1", "algo", {"b": 2, "a": 1})
    right = CacheIdentity("input", "model", "1", "algo", {"a": 1, "b": 2})

    assert build_cache_key(left) == build_cache_key(right)


def test_cache_key_changes_when_relevant_identity_changes() -> None:
    base = CacheIdentity("input", "model", "1", "algo", {"p": 1})
    changed = CacheIdentity("input", "model", "2", "algo", {"p": 1})

    assert build_cache_key(base) != build_cache_key(changed)


def test_resource_budget_rejects_unbounded_values() -> None:
    with pytest.raises(ValueError, match="positive"):
        ResourceBudget(queue_capacity=0)

    with pytest.raises(ValueError, match="max_vram_fraction"):
        ResourceBudget(max_vram_fraction=1.5)
