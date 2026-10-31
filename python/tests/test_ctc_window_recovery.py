from __future__ import annotations

from collections.abc import Sequence
import json
from pathlib import Path

import numpy as np
import pytest
import torch

from backend.ai_worker import ctc
from backend.ai_worker.recognition import alignment_payload


def _emissions(words: Sequence[str]) -> torch.Tensor:
    tokens = [
        token
        for word in words
        for character in ctc._character_tokens(word, " ".join(words))
        for token in character
    ]
    path: list[int] = []
    for token in tokens:
        if path and path[-1] == token:
            path.append(0)
        path.append(token)
    path.append(0)  # The transcript's trailing wildcard needs its own frame.
    scores = torch.full((len(path), 28), -12.0)
    scores[torch.arange(len(path)), path] = 0
    return scores.log_softmax(-1)


@pytest.mark.parametrize("text", ["дом", "дім", "привет", "привіт", "мама"])
def test_valid_fast_ctc_path_does_not_fall_back_to_proportional_word_times(text):
    scores = _emissions([text])

    word = ctc.align_words(scores, 0.02, [text])[0]

    assert word.score > 0.99
    assert word.start == 0
    assert word.end == pytest.approx((len(scores) - 1) * 0.02)
    assert all(left <= right for left, right in zip(word.letters, word.letters[1:]))


def test_window_recovers_from_a_short_crop_with_trusted_local_context():
    scores = torch.full((100, 28), -12.0)
    scores[:, 0] = 0
    acoustic = _emissions(["привіт"])
    scores[30 : 30 + len(acoustic)] = acoustic

    word = ctc._align_window(
        scores,
        0.02,
        ["привіт"],
        ctc.Window(0, 1, 0.5, 0.54, 0.6),
        recovery_bounds=(0.4, 0.9),
    )[0]

    assert word.score > 0.99
    assert word.start == pytest.approx(0.6)
    assert word.end == pytest.approx(0.6 + (len(acoustic) - 1) * 0.02)


def test_guided_alignment_supplies_local_recovery_bounds_and_preserves_a_fast_neighbor():
    scores = torch.full((100, 28), -12.0)
    scores[:, 0] = 0
    for first, text in ((30, "привіт"), (60, "ти")):
        acoustic = _emissions([text])
        scores[first : first + len(acoustic)] = acoustic
    whole = [
        ctc.AlignedWord("привіт", 0.5, 0.54, (), 0.01),
        ctc.AlignedWord("ти", 1.2, 1.24, (1.2, 1.22), 0.99),
    ]

    words = ctc.align_guided(
        scores,
        0.02,
        [word.text for word in whole],
        [ctc.Window(0, 1, 0.5, 0.54), ctc.Window(1, 2, 1.2, 1.4)],
        {1: 1.2},
        whole=whole,
    )

    assert (words[0].start, words[0].end) == pytest.approx((0.6, 0.72))
    assert (words[1].start, words[1].end) == pytest.approx((1.2, 1.24))
    assert words[0].end <= words[1].start


def test_cropped_ukrainian_recording_recovers_cached_phonemes_between_its_neighbors():
    with np.load(Path(__file__).with_name("fixtures") / "chorus-entry.npz") as fixture:
        words = json.loads(str(fixture["entry_metadata"]))["words"]
        scores = torch.from_numpy(fixture["entry_scores"])
    previous, expected, following = words[5:8]

    word = ctc._align_window(
        scores,
        0.02,
        [expected["text"]],
        ctc.Window(6, 7, expected["start"], expected["start"] + 0.04),
        recovery_bounds=(previous["end"], following["start"]),
    )[0]

    assert word.score > 0.2
    assert (word.start, word.end) == pytest.approx((expected["start"], expected["end"]), abs=0.02)
    assert previous["end"] <= word.start < word.end <= following["start"]


def test_window_recovery_is_bounded_and_approximation_remains_observable(monkeypatch):
    calls: list[tuple[float, float]] = []

    def impossible(scores, step, _words, offset):
        calls.append((offset, offset + len(scores) * step))
        raise ValueError("The vocal track is too short for the lyrics")

    monkeypatch.setattr(ctc, "align_words", impossible)
    words = ctc._align_window(
        torch.zeros(10_000, 28),
        0.02,
        ["дом", "ти"],
        ctc.Window(0, 2, 10, 10.04, 10.02),
        recovery_bounds=(9.9, 10.6),
    )

    assert len(calls) == 2
    assert calls[1][0] >= 9.9 - 1e-9
    assert calls[1][1] <= 10.6 + 1e-9
    assert all(word.score == 0 for word in words)
    assert all(
        "ApproximateAlignment" in word["diagnostics"]
        for word in alignment_payload(words, {})["words"]
    )


def test_failed_crop_without_trusted_bounds_does_not_search_neighboring_words(monkeypatch):
    calls = []

    def impossible(scores, step, _words, offset):
        calls.append((offset, offset + len(scores) * step))
        raise ValueError("The vocal track is too short for the lyrics")

    monkeypatch.setattr(ctc, "align_words", impossible)

    result = ctc._align_window(torch.zeros(100, 28), 0.02, ["дом"], ctc.Window(0, 1, 1, 1.04))

    assert len(calls) == 1
    assert result[0].score == 0


def test_recovery_context_does_not_expand_to_the_whole_song(monkeypatch):
    calls = []

    def impossible(scores, step, _words, offset):
        calls.append((offset, offset + len(scores) * step))
        raise ValueError("The vocal track is too short for the lyrics")

    monkeypatch.setattr(ctc, "align_words", impossible)
    ctc._align_window(
        torch.zeros(20_000, 28),
        0.02,
        ["привет"],
        ctc.Window(0, 1, 100, 100.04),
        recovery_bounds=(0, 400),
    )

    assert len(calls) == 2
    assert calls[1][0] >= 100 - ctc._CONTEXT_SECONDS
    assert calls[1][1] <= 100.04 + ctc._CONTEXT_SECONDS + 1e-9


def test_impossible_lattice_is_rejected_before_native_alignment():
    scores = _emissions(["привет"])

    with pytest.raises(ValueError, match="too short"):
        ctc.align_words(scores[:-1], 0.02, ["привет"])


def test_successful_crop_is_not_repeated_even_with_recovery_bounds():
    scores = _emissions(["мама"])

    word = ctc._align_window(
        scores,
        0.02,
        ["мама"],
        ctc.Window(0, 1, 0, len(scores) * 0.02),
        recovery_bounds=(0, len(scores) * 0.02),
    )[0]

    assert word.score > 0.99
    assert word.end == pytest.approx((len(scores) - 1) * 0.02)
