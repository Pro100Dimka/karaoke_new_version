from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from backend.ai_worker import speech
from backend.ai_worker.guidance_prefix import preserve_prefix


def heard(text, start):
    return [(word.casefold(), start + i, start + i + 0.4) for i, word in enumerate(text.split())]


def guidance():
    original = "Soft voices\nAt the café\nStars guide us"
    recovered = "Soft voices\nAt the café we sing softly\nStars guide us"
    prefix = heard("Soft voices", 1)
    previous = [
        *prefix,
        ("at", 9, 9.02),
        ("the", 9.02, 9.04),
        ("café", 9.04, 9.06),
        *heard("Stars guide us", 12),
    ]
    selected = [
        *heard("Music", 0),
        *heard("At the cafe we sing softly", 4),
        *heard("Stars guide us", 12),
    ]
    return original, recovered, prefix, previous, selected


def test_asr_reselection_keeps_missing_native_prefix_without_pinning_recovered_phrase(monkeypatch):
    original, recovered, prefix, previous, selected = guidance()
    raw = {"text": original, "segments": [], "sourceId": "vocal"}
    captured = {}
    monkeypatch.setattr(speech, "read_mono", lambda *_: np.zeros(16_000, dtype=np.float32))

    def evidence(*args, **kwargs):
        args[6].extend([previous, selected])
        return "saved scores", 0.02, previous

    def align(operation, hints, recognize):
        captured["heard"] = operation.heard
        captured["views"] = operation.views
        return {"words": []}

    def payload(lyrics, result, observations, scores, step, verified):
        captured["raw"] = observations.recognition
        captured["fresh"] = observations.views
        return dict(result, lyrics=lyrics, insertionsVerified=verified)

    monkeypatch.setattr(speech, "_alignment_evidence", evidence)
    monkeypatch.setattr(speech, "_recover_transcript_lyrics", lambda *_: (recovered, True))
    monkeypatch.setattr(speech._AlignmentPass, "run", align)
    monkeypatch.setattr(speech, "_asr_payload", payload)

    result = speech.align(
        Path("cached-vocal.wav"), original, "English", recognition=raw, asr_lyrics=True
    )

    assert captured["heard"] == sorted([*selected, *prefix], key=lambda word: word[1])
    assert next(word for word in captured["heard"] if word[0] == "at")[1:] == (4, 4.4)
    assert captured["views"] == [previous, selected]
    assert captured["raw"] is raw
    assert captured["fresh"] == []
    assert result["lyrics"] == recovered
    assert result["insertionsVerified"] is True


@pytest.mark.parametrize(
    "problem",
    [
        "unrelated_spelling",
        "later_occurrence",
        "overlap_lyric_anchor",
        "overlap_other_selected_word",
        "overlapping_prefix_words",
        "zero_duration",
        "nonfinite",
    ],
)
def test_invalid_or_conflicting_native_prefix_keeps_selected_guide(problem):
    original, recovered, _, previous, selected = guidance()
    if problem == "unrelated_spelling":
        previous[0] = ("rough", 1, 1.4)
    elif problem == "later_occurrence":
        previous[:2] = heard("Soft voices", 20)
    elif problem == "overlap_lyric_anchor":
        previous[1] = ("voices", 2, 4.1)
    elif problem == "overlap_other_selected_word":
        selected[0] = ("music", 0, 1.2)
    elif problem == "overlapping_prefix_words":
        previous[0] = ("soft", 1, 2.1)
    elif problem == "zero_duration":
        previous[0] = ("soft", 1, 1)
    else:
        previous[0] = ("soft", float("nan"), 1.4)

    assert preserve_prefix(original, recovered, previous, selected) is selected


@pytest.mark.parametrize("ambiguous", ["native_prefix", "written_prefix", "selected_anchor"])
def test_repeated_occurrence_cannot_supply_an_unambiguous_prefix(ambiguous):
    original, recovered, prefix, previous, selected = guidance()
    if ambiguous == "native_prefix":
        previous.extend(heard("Soft voices", 20))
    elif ambiguous == "written_prefix":
        original += "\nSoft voices"
        recovered += "\nSoft voices"
    else:
        selected.extend((text, start + 20, end + 20) for text, start, end in selected[1:].copy())

    assert preserve_prefix(original, recovered, previous, selected) is selected


def test_prefix_already_observed_elsewhere_is_not_duplicated():
    original, recovered, _, previous, selected = guidance()
    selected.extend(heard("Soft voices", 20))

    assert preserve_prefix(original, recovered, previous, selected) is selected


def test_newly_written_prefix_does_not_borrow_old_unrelated_context():
    original, recovered, _, previous, selected = guidance()
    original = original.replace("Soft voices", "Distant thunder")

    assert preserve_prefix(original, recovered, previous, selected) is selected


def test_unchanged_lyrics_do_not_change_the_guide():
    original, _, _, previous, selected = guidance()

    assert preserve_prefix(original, original, previous, selected) is selected


def test_preserved_native_anchors_keep_their_original_tuples_and_leave_inputs_unchanged():
    original, recovered, prefix, previous, selected = guidance()
    original_previous, original_selected = previous.copy(), selected.copy()

    result = preserve_prefix(original, recovered, previous, selected)

    assert result == sorted([*selected, *prefix], key=lambda word: word[1])
    assert result[1] is previous[0]
    assert result[2] is previous[1]
    assert previous == original_previous
    assert selected == original_selected
