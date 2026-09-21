from __future__ import annotations

from datetime import UTC, datetime

import pytest

from backend.lyrics.domain import LyricsDocument, Note, Word
from backend.processing.cache_key import CacheIdentity, build_cache_key
from backend.processing.domain import Job, JobState, JobType
from backend.processing.policies import ResourceBudget


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
