from __future__ import annotations

from dataclasses import replace

import numpy as np
import pytest
import torch

from backend.ai_worker import ctc, speech_alignment
from backend.ai_worker.ctc_occurrences import displaced_prefix


def _scenario():
    words = "we sing now we sing now we sing now stay".split()
    scores = torch.full((400, 28), np.log(0.0001))
    scores[:, 0] = np.log(0.999)
    runs = [
        (words[:3], (1.0, 1.5, 2.0), 0.002, 5),
        (words[:3], (3.0, 3.5, 4.0), 0.8, 5),
        (words[:3], (4.4, 4.46, 4.54), 0.08, 1),
        (words[6:], (5.0, 5.5, 6.0, 7.0), 0.8, 5),
    ]
    for texts, starts, strength, gap in runs:
        for text, start in zip(texts, starts, strict=True):
            tokens = [token for part in ctc._character_tokens(text) for token in part]
            for offset, token in enumerate(tokens):
                scores[round(start / 0.02) + offset * gap, token] = np.log(strength)
    scores = torch.log_softmax(scores, dim=-1)
    heard = [
        (word, start, start + 0.4)
        for word, start in zip(words, (1.0, 1.5, 2.0, 3.0, 3.5, 4.0, 5.0, 5.5, 6.0, 7.0))
    ]
    return words, scores, heard, ctc.align_words(scores, 0.02, words)


def test_a_measured_repeat_keeps_its_recognized_occurrence_and_recovers_the_missing_prefix(
    monkeypatch,
):
    words, scores, heard, whole = _scenario()
    assert [word.start for word in whole[:3]] == [3.0, 3.5, 4.0]
    assert ctc._implausible(whole, np.ones(800, bool)) == 2
    intervals = {index: (start, end) for index, (_, start, end) in enumerate(heard)}
    operation = speech_alignment._AlignmentPass(
        np.zeros(8 * 16000, np.float32), None, scores, 0.02, words, " ".join(words), heard, []
    )
    monkeypatch.setattr(speech_alignment, "voiced_frames", lambda *_: np.ones(800, bool))
    monkeypatch.setattr(speech_alignment, "vocal_onsets", lambda *_: np.empty(0))

    result, _, _ = operation._guided_words(
        [ctc.Window(0, len(words), 0.8, 7.8, 1.0)],
        intervals,
        whole,
        {index: start for index, (start, _) in intervals.items()},
    )

    assert [word.start for word in result[:6]] == pytest.approx([1.0, 1.5, 2.0, 3.0, 3.5, 4.0])
    assert result[3:6] == ctc.ordered(whole[:3])
    assert result[6:] == ctc.ordered(whole[6:])
    assert [word.text for word in result] == words


@pytest.mark.parametrize(
    "case",
    [
        "genuine",
        "weak",
        "unrecognized_source",
        "unrecognized_target",
        "overlap",
        "shared",
        "spelling",
        "romanization",
        "punctuation_repeat",
        "digits",
        "strong_target",
        "short_window",
        "suffix_overlap",
        "invalid_interval",
    ],
)
def test_ambiguous_or_already_confirmed_occurrences_keep_their_measured_cores(case):
    _, scores, heard, whole = _scenario()
    timings = {index: (start, end) for index, (_, start, end) in enumerate(heard)}
    window = ctc.Window(0, len(whole), 0.8, 7.8, 1.0)
    assert displaced_prefix(whole, window, timings) == (3, 3)
    if case == "genuine":
        first = ctc._align_window(scores, 0.02, [w.text for w in whole[:3]], replace(window, end=3))
        whole = [*first, *whole[:3], *whole[6:]]
    elif case == "weak":
        whole[1] = replace(whole[1], score=ctc._PREFERENCE)
    elif case.startswith("unrecognized"):
        timings.pop(1 if case.endswith("source") else 4)
    elif case == "overlap":
        timings[3] = (2.2, 3.4)
    elif case == "shared":
        timings.update({3 + index: timings[index] for index in range(3)})
    elif case in {"spelling", "romanization"}:
        whole[3] = replace(whole[3], text="we!" if case == "spelling" else "wе")
    elif case == "punctuation_repeat":
        for index in range(6):
            word = whole[index]
            whole[index] = replace(
                word,
                text=("we!", "we?", "we,")[index % 3],
                letters=tuple(np.linspace(word.start, word.end - 0.01, 3)),
            )
    elif case == "digits":
        whole[0], whole[3] = replace(whole[0], text="17"), replace(whole[3], text="17")
    elif case == "strong_target":
        whole[3] = replace(whole[0], start=3.05, end=3.2, letters=(3.05, 3.15))
    elif case == "short_window":
        window = replace(window, end=4.1)
    elif case == "suffix_overlap":
        whole[6] = replace(whole[6], start=4.1)
    elif case == "invalid_interval":
        timings[2] = (float("nan"), 2.4)

    assert displaced_prefix(whole, window, timings) is None


@pytest.mark.parametrize("failure", ["interpolation", "count", "overlap", "crammed"])
def test_an_unusable_prefix_crop_cannot_displace_any_existing_core(monkeypatch, failure):
    _, scores, heard, whole = _scenario()
    timings = {index: (start, end) for index, (_, start, end) in enumerate(heard)}
    window = ctc.Window(0, len(whole), 0.8, 7.8, 1.0)
    native = ctc._align_window

    def crop(emissions, step, text, bounds):
        prefix = native(emissions, step, text, bounds)
        if failure == "interpolation":
            return [replace(word, score=0) for word in prefix]
        if failure == "count":
            return prefix[:-1]
        if failure == "overlap":
            return [*prefix[:-1], replace(prefix[-1], end=bounds.end + 0.1)]
        return [replace(word, end=word.start + 0.02) for word in prefix]

    monkeypatch.setattr(ctc, "_align_window", crop)
    result = ctc._guided_occurrence(
        whole,
        [],
        scores,
        0.02,
        window,
        {index: start for index, (start, _) in timings.items()},
        np.ones(800, bool),
        timings,
    )

    assert result is whole


def test_nonzero_word_indices_preserve_preceding_and_following_cores(monkeypatch):
    words, scores, heard, _ = _scenario()
    for offset, part in enumerate(ctc._character_tokens("go")):
        scores[5 + offset * 5, part[0]] = np.log(0.8)
    scores = torch.log_softmax(scores, dim=-1)
    words, heard = ["go", *words], [("go", 0.1, 0.4), *heard]
    whole = ctc.align_words(scores, 0.02, words)
    intervals = {index: (start, end) for index, (_, start, end) in enumerate(heard)}
    operation = speech_alignment._AlignmentPass(
        np.zeros(8 * 16000, np.float32), None, scores, 0.02, words, " ".join(words), heard, []
    )
    monkeypatch.setattr(speech_alignment, "voiced_frames", lambda *_: np.ones(800, bool))
    monkeypatch.setattr(speech_alignment, "vocal_onsets", lambda *_: np.empty(0))

    result, _, _ = operation._guided_words(
        [ctc.Window(0, 1, 0, 0.8), ctc.Window(1, len(words), 0.8, 7.8, 1.0)],
        intervals,
        whole,
        {index: start for index, (start, _) in intervals.items()},
    )

    assert result[0] == ctc.ordered(whole[:1])[0]
    assert [word.start for word in result[1:4]] == pytest.approx([1.0, 1.5, 2.0])
    assert result[4:7] == ctc.ordered(whole[1:4])
    assert result[7:] == ctc.ordered(whole[7:])


def test_fuzzy_contextual_intervals_cannot_authorize_repeat_ownership(monkeypatch):
    words, scores, heard, whole = _scenario()
    exact = list(heard)
    heard[4] = ("s", *heard[4][1:])
    supported = {index: (start, end) for index, (_, start, end) in enumerate(exact)}
    operation = speech_alignment._AlignmentPass(
        np.zeros(8 * 16000, np.float32), None, scores, 0.02, words, " ".join(words), heard, []
    )
    observed = []
    original = ctc.displaced_prefix

    def ownership(values, window, timings):
        observed.append(timings)
        return original(values, window, timings)

    monkeypatch.setattr(ctc, "displaced_prefix", ownership)
    monkeypatch.setattr(speech_alignment, "voiced_frames", lambda *_: np.ones(800, bool))
    monkeypatch.setattr(speech_alignment, "vocal_onsets", lambda *_: np.empty(0))
    result, _, _ = operation._guided_words(
        [ctc.Window(0, len(words), 0.8, 7.8, 1.0)],
        supported,
        whole,
        {index: start for index, (start, _) in supported.items()},
    )

    assert observed and all(4 not in timings for timings in observed)
    assert result[0].start == 3.0
