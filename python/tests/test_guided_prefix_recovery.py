from __future__ import annotations

from dataclasses import replace
import numpy as np
import pytest
import torch
from backend.ai_worker import ctc


def _word(text, start, end, score=0.5):
    return ctc.AlignedWord(
        text, start, end, tuple(np.linspace(start, end - 0.02, len(text))), score
    )


def _scenario(monkeypatch, *, core="confirmed", contained=False, measured=True):
    prefix = [_word("we", 0.4, 0.8), _word("hold", 1.2, 1.4, 0.9)]
    suffix = [_word("one", 1.45, 1.7), _word("clear", 1.8, 2.1), _word("tone", 2.3, 2.6)]
    reference = [*prefix, _word("one", 4.0, 4.3), _word("clear", 4.4, 4.8), _word("tone", 5.0, 5.4)]
    guided = [prefix[0], _word("hold", 0.9, 0.96, 0.1), *suffix]
    anchors = {1: 1.21, 2: 1.45, 3: 1.8, 4: 2.3, 5: 3.1}
    if core == "weak":
        reference[1] = replace(reference[1], score=0.01)
    if core == "unrecognized":
        anchors.pop(1)
    if core == "contradicted":
        anchors[1] = 2.0
    if core == "outside":
        reference[1] = _word("hold", 2.9, 3.1, 0.9)
    if core == "prefix_disagrees":
        anchors[0] = 0.0
    if core == "suffix_unrecognized":
        for index in (2, 3, 4):
            anchors.pop(index)
    if contained:
        reference[2:] = suffix
    following = _word("again", 3.1, 3.7)
    whole = [*reference, _word("again", 5.6, 6.2)]
    crops = []

    def crop(_scores, _step, chunk, window, **_options):
        if chunk == [word.text for word in reference]:
            return guided
        if chunk == [following.text]:
            return [following]
        crops.append(window)
        assert chunk == [word.text for word in suffix]
        assert window.start >= prefix[-1].end and window.end <= 2.8
        return suffix if measured else [replace(word, score=0) for word in suffix]

    monkeypatch.setattr(ctc, "_align_window", crop)
    result = ctc.align_guided(
        torch.zeros((400, 28)),
        0.02,
        [word.text for word in whole],
        [ctc.Window(0, 5, 0.2, 2.8), ctc.Window(5, 6, 3.0, 3.8)],
        anchors,
        np.ones(800, dtype=bool),
        whole,
        anchors=anchors,
    )
    return result, prefix, suffix, following, crops


def test_confirmed_core_recovers_late_suffix_and_keeps_next_phrase(monkeypatch):
    result, prefix, suffix, following, _ = _scenario(monkeypatch)
    assert result == ctc.ordered([*prefix, *suffix, following])
    assert [word.text for word in result] == ["we", "hold", "one", "clear", "tone", "again"]
    assert result[1].letters == pytest.approx(prefix[1].letters, abs=1e-12)
    assert result[-1].start == 3.1


@pytest.mark.parametrize(
    "core",
    ["weak", "unrecognized", "contradicted", "outside", "prefix_disagrees", "suffix_unrecognized"],
)
def test_retry_requires_a_confirmed_in_window_core(monkeypatch, core):
    result, _, _, _, crops = _scenario(monkeypatch, core=core)
    assert not crops
    assert result[4].start == (2.3 if core in {"weak", "prefix_disagrees"} else 5.0)


def test_already_contained_reference_is_not_retried(monkeypatch):
    result, prefix, suffix, following, crops = _scenario(monkeypatch, contained=True)
    assert not crops
    assert result == ctc.ordered([*prefix, *suffix, following])


def test_failed_retry_cannot_replace_measured_words_with_interpolation(monkeypatch):
    result, _, _, _, _ = _scenario(monkeypatch, measured=False)
    assert result[2].start == 4.0 and result[4].start == 5.0
    assert all(word.score > 0 for word in result)
