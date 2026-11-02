from dataclasses import replace
import json
from pathlib import Path

import numpy as np
import pytest
import torch

from backend.ai_worker import ctc, word_guidance


@pytest.fixture
def disputed_boundary():
    with np.load(Path(__file__).with_name("fixtures") / "wildways-verse-entry.npz") as fixture:
        case = json.loads(str(fixture["uncertain_metadata"]))
        scores = torch.from_numpy(fixture["uncertain_scores"])
    words = ctc.align_words(scores, 0.02, case["lyrics"].split())
    window = ctc.Window(5, 10, case["hints"][1]["start"] - 0.6, case["hints"][2]["start"] + 0.6)
    heard = {8: tuple(case["heard"][9][1:]), 9: tuple(case["heard"][10][1:])}
    return words, scores, window, heard, case["onsets"]


def _guide(case):
    words, scores, window, heard, onsets = case
    return word_guidance.with_word_guidance(
        words, scores, 0.02, [window], heard, np.ones(1600, bool), 0.6, onsets=onsets
    )


def test_a_disputed_phrase_tail_keeps_real_ctc_letters_before_the_following_core(disputed_boundary):
    words, scores, *_ = disputed_boundary

    result = _guide(disputed_boundary)

    # The related wave has an independently inspected articulation at 9.42--9.49.
    # The initial vowel seam is uncertain; later letters must come from CTC, not equal spacing.
    assert result[9].start < 9.5
    assert 9.42 <= result[9].letters[1] <= 9.49
    assert result[9].letters[2] == pytest.approx(9.58)
    assert result[9].letters[3] == pytest.approx(9.96)
    assert result[9].score > 0
    assert "OnsetAtSearchBoundary" in result[9].diagnostics
    assert "TimingReviewRequired" in result[9].diagnostics
    assert result[9].end == result[10].start == pytest.approx(9.98)
    assert result[8] == words[8]
    assert result[10].letters[1:] == words[10].letters[1:]
    assert result[11:] == words[11:]
    bounded = ctc.align_words(scores[455:499], 0.02, [words[9].text], 9.1, bounded_end=True)[0]
    assert result[9].letters == bounded.letters


@pytest.mark.parametrize(
    "guard",
    [
        "strong_opening",
        "fresh_onset",
        "fast_predecessor",
        "strong_next",
        "changed_following_body",
        "long_context",
    ],
)
def test_a_boundary_repair_preserves_confirmed_or_incompatible_neighbours(disputed_boundary, guard):
    words, scores, window, heard, onsets = disputed_boundary
    words, scores, heard, onsets = list(words), scores.clone(), dict(heard), list(onsets)
    if guard == "strong_opening":
        words[9] = replace(words[9], score=0.9)
        scores[round(words[9].start / 0.02), ctc._character_tokens(words[9].text)[0][0]] = np.log(
            0.9
        )
    elif guard == "fresh_onset":
        onsets.append(9.9)
    elif guard == "fast_predecessor":
        words[8] = ctc.AlignedWord("мы", 9.06, 9.14, (9.06, 9.1), 0.9)
        heard[8] = (9.06, 9.14)
    elif guard == "strong_next":
        words[10] = replace(words[10], score=0.9)
    elif guard == "changed_following_body":
        words[11] = replace(words[11], end=11.6)
    else:
        words[11] = replace(words[11], end=100)
        padding = scores.new_full((5000 - len(scores), scores.shape[1]), -20)
        padding[:, 0] = 0
        scores = torch.cat((scores, padding))

    result = _guide((words, scores, window, heard, onsets))

    assert result[9] == words[9]
    assert result[10:] == words[10:]
    if guard == "fast_predecessor":
        assert result[8] == words[8]


def test_the_following_anchor_and_disputed_core_are_accepted_together(disputed_boundary):
    words, scores, window, heard, onsets = disputed_boundary
    # A small disputed-word gain cannot silently keep the next word at a different boundary.
    heard = dict(heard) | {9: (9.33, 10.04), 10: (10.08, 10.78)}

    result = _guide((words, scores, window, heard, onsets))

    assert result[9:11] == words[9:11]


def test_a_recovered_search_edge_remains_explicitly_reviewable(disputed_boundary):
    _, scores, _, heard, onsets = disputed_boundary
    guided = _guide(disputed_boundary)
    # Partial spelling supplied the initial span, but independent exact matching misses this word.
    independent = {8: heard[8]}

    reviewed = word_guidance.with_word_guidance(
        guided,
        scores,
        0.02,
        [],
        independent,
        np.ones(1600, bool),
        0.6,
        onsets=onsets,
        reviewed=frozenset({8, 9}),
    )

    assert reviewed[9].start < 9.5
    assert reviewed[9].letters == guided[9].letters
    assert "OnsetAtSearchBoundary" in reviewed[9].diagnostics
    assert "TimingReviewRequired" in reviewed[9].diagnostics
    assert reviewed[9].end <= reviewed[10].start


@pytest.mark.parametrize("failure", ["too_short", "unsupported"])
def test_a_failed_bounded_search_preserves_both_original_cores_and_diagnostics(
    disputed_boundary, monkeypatch, failure
):
    words, scores, window, heard, onsets = disputed_boundary
    words = list(words)
    words[9] = replace(words[9], diagnostics=("ExistingEvidence",))
    align_words = ctc.align_words

    def bounded_failure(*args, **kwargs):
        if not kwargs.get("bounded_end"):
            return align_words(*args, **kwargs)
        if failure == "too_short":
            raise ValueError("The vocal track is too short for the lyrics")
        return [replace(align_words(*args, **kwargs)[0], score=0.0)]

    monkeypatch.setattr(ctc, "align_words", bounded_failure)

    result = _guide((words, scores, window, heard, onsets))

    assert result[9:11] == words[9:11]
