from __future__ import annotations

import numpy as np
import pytest
import torch

from backend.ai_worker import ctc
from backend.ai_worker.acoustic_retry import recover_emission


RATE = 16_000
STEP = 0.02
WORDS = list("abcdefghi")
LYRICS = " ".join(WORDS)


def _spike(scores, text, time, probability=0.9):
    frame = round(time / STEP)
    token = ctc._character_tokens(text, LYRICS)[0][0]
    values = torch.full_like(scores[frame], 1e-8)
    values[0], values[token] = 1 - probability, probability
    scores[frame] = (values / values.sum()).log()


def _case():
    audio = np.arange(10 * RATE, dtype=np.float32)
    values = torch.full((500, 28), 1e-8)
    values[:, 0] = 1
    old = (values / values.sum(dim=1, keepdim=True)).log()
    for text, time in zip(WORDS, [0.2, 1.2, 2.2, 5.8, 6.0, 6.2, 7.2, 8.2, 9.2], strict=True):
        _spike(old, text, time)
    recovered = old.clone()
    for time in [5.8, 6.0, 6.2]:
        recovered[round(time / STEP)] = (values[0] / values[0].sum()).log()
    for text, time in zip(WORDS[3:6], [3.2, 4.2, 5.2], strict=True):
        _spike(recovered, text, time)
    views = [
        [
            (text, time + shift, time + 0.2 + shift)
            for text, time in zip(WORDS, [0.2, 1.2, 2.2, 3.2, 4.2, 5.2, 7.2, 8.2, 9.2], strict=True)
        ]
        for shift in [0.0, 0.02]
    ]
    return audio, old, recovered, views


class _CapturedEmission:
    def __init__(self, scores, *, step=STEP):
        self.scores, self.step, self.crops = scores, step, []

    def __call__(self, audio):
        start = round(float(audio[0]) / RATE / STEP)
        frames = round(len(audio) / RATE / STEP)
        self.crops.append((float(audio[0]) / RATE, len(audio) / RATE))
        return self.scores[start : start + frames].clone(), self.step


def test_blank_displaced_run_gets_one_bounded_retry_without_changing_neighbor_anchors():
    audio, old, recovered, views = _case()
    emit = _CapturedEmission(recovered)
    result = recover_emission(audio, old, STEP, LYRICS, views, emit)
    before = ctc.align_words(old, STEP, WORDS)
    after = ctc.align_words(result, STEP, WORDS)

    assert len(emit.crops) == 1, "overlapping failing words are one acoustic retry"
    assert emit.crops[0] == pytest.approx((0.22, 8.98))
    assert [word.start for word in after[3:6]] == pytest.approx([3.2, 4.2, 5.2])
    assert after[:3] == before[:3] and after[6:] == before[6:]
    assert torch.equal(result[:111], old[:111]) and torch.equal(result[360:], old[360:])
    assert torch.equal(old, _case()[1]), "the caller's original scores are immutable"


@pytest.mark.parametrize("evidence", ["single_view", "distant_occurrence", "zero_duration"])
def test_uncorroborated_recognition_does_not_start_an_acoustic_retry(evidence):
    audio, old, recovered, views = _case()
    if evidence == "single_view":
        views = views[:1]
    elif evidence == "distant_occurrence":
        views[1] = [(word, start + 20, end + 20) for word, start, end in views[1]]
    else:
        views[1] = [(word, start, start) for word, start, _ in views[1]]
    emit = _CapturedEmission(recovered)

    assert recover_emission(audio, old, STEP, LYRICS, views, emit) is old
    assert emit.crops == []


def test_an_already_supported_expected_core_does_not_trigger_a_blank_context_retry():
    audio, old, recovered, views = _case()
    for text, time in zip(WORDS[3:6], [3.2, 4.2, 5.2], strict=True):
        _spike(old, text, time, probability=0.3)
    emit = _CapturedEmission(recovered)

    assert recover_emission(audio, old, STEP, LYRICS, views, emit) is old
    assert emit.crops == []


def test_correct_alignment_does_not_spend_another_model_inference():
    audio, _, good, views = _case()
    emit = _CapturedEmission(good)

    assert recover_emission(audio, good, STEP, LYRICS, views, emit) is good
    assert emit.crops == []


def test_earlier_drift_stays_on_the_existing_guidance_path():
    audio, old, recovered, views = _case()
    for time in [5.8, 6.0, 6.2]:
        old[round(time / STEP)] = old[0]
    for text, time in zip(WORDS[3:6], [2.3, 2.5, 2.7], strict=True):
        _spike(old, text, time)
    emit = _CapturedEmission(recovered)

    assert recover_emission(audio, old, STEP, LYRICS, views, emit) is old
    assert emit.crops == []


def test_missing_supported_left_neighbor_does_not_open_an_unbounded_search():
    audio, old, recovered, views = _case()
    for text, time in zip(WORDS[:3], [0.2, 1.2, 2.2], strict=True):
        _spike(old, text, time, probability=0.01)
    emit = _CapturedEmission(recovered)

    assert recover_emission(audio, old, STEP, LYRICS, views, emit) is old
    assert emit.crops == []


@pytest.mark.parametrize("failure", ["same_weak_path", "different_grid", "nan", "neighbor_change"])
def test_unsupported_retry_cannot_replace_original_emissions(failure):
    audio, old, recovered, views = _case()
    if failure == "same_weak_path":
        recovered = old
    elif failure == "nan":
        recovered[round(4.2 / STEP), 0] = float("nan")
    elif failure == "neighbor_change":
        _spike(recovered, "c", 3.0, probability=0.999)
    emit = _CapturedEmission(recovered, step=0.04 if failure == "different_grid" else STEP)

    assert recover_emission(audio, old, STEP, LYRICS, views, emit) is old
    assert len(emit.crops) == 1


def test_malformed_empty_input_does_not_call_the_model():
    audio, _, recovered, views = _case()
    old = torch.empty((0, 28))
    emit = _CapturedEmission(recovered)

    assert recover_emission(audio, old, STEP, LYRICS, views, emit) is old
    assert emit.crops == []


@pytest.mark.parametrize("keeps_neighbors", [False, True])
@pytest.mark.parametrize("has_onset", [False, True])
def test_weak_phrase_entry_keeps_its_stable_following_words(
    keeps_neighbors,
    has_onset,
):
    from backend.ai_worker.acoustic_retry import recover_weak_cue_entries

    def word(text, start, end, score):
        return ctc.AlignedWord(text, start, end, (), score)

    words = [
        word("you", 23.84, 24.16, 0.22),
        word("Maybe", 25.42, 25.66, 0.015),
        word("it", 25.66, 25.82, 0.1),
        word("hurts", 25.9, 26.38, 0.33),
    ]
    calls = []

    def fit(text, start, end):
        calls.append((text, start, end))
        return [
            word("Maybe", 25.16, 25.55, 0.4),
            word("it", 25.58 if keeps_neighbors else 25.38, 25.82, 0.11),
            word("hurts", 25.9, 26.38, 0.35),
        ]

    onsets = [24.07, 25.11] if has_onset else [24.07, 25.58]
    result = recover_weak_cue_entries(words, [(1, 25.08, "Maybe it hurts")], onsets, fit)
    assert calls == [
        (
            ["Maybe", "it", "hurts"],
            pytest.approx(24.51 if has_onset else 24.48),
            pytest.approx(26.98),
        )
    ]
    assert result[1].start == (25.16 if keeps_neighbors else 25.42)
    assert result[0] == words[0] and result[2:] == words[2:]


@pytest.mark.parametrize("recovered", [False, True])
def test_a_compressed_repeated_cue_refits_the_phrase_inside_its_neighbours(recovered):
    from backend.ai_worker.acoustic_retry import recover_compressed_cues

    text = "We sing now we sing now we sing now again"

    def group(starts, score):
        return [
            ctc.AlignedWord(t, start, start + 0.08, (), score)
            for t, start in zip(text.split(), starts, strict=True)
        ]

    previous = ctc.AlignedWord("begin", 1.0, 1.5, (), 0.9)
    following = ctc.AlignedWord("after", 9.6, 10.0, (), 0.9)
    words = [previous, *group([2, 2.3, 6, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 9], 0.025), following]
    candidate = group([2, 2.3, 2.6, 3.3, 3.6, 4, 5, 5.3, 5.6, 9], 0.3 if recovered else 0.02)

    def fit(tokens, start, end):
        assert tokens == text.split()
        assert 1.5 <= start <= 2 and 9 < end <= following.start
        return candidate

    result = recover_compressed_cues(words, [(1, 2, text)], fit)
    assert result[0] == previous and result[-1] == following
    assert result[1:-1] == (candidate if recovered else words[1:-1])


@pytest.mark.parametrize(
    "anchor_shift,following_score,accepted", [(0, 0.5, True), (0.2, 0.5, False), (0, 0.09, False)]
)
def test_initial_weak_phrase_can_recover_its_prefix_while_preserving_the_right_anchor(
    anchor_shift, following_score, accepted
):
    from backend.ai_worker.acoustic_retry import recover_weak_cue_entries

    words = [
        ctc.AlignedWord("we", 1.35, 1.5, (1.35, 1.45), 0.01),
        ctc.AlignedWord("sing", 1.6, 2.1, (), 0.08),
        ctc.AlignedWord("together", 2.3, 2.9, (), 0.8),
    ]
    candidate = [
        ctc.AlignedWord("we", 0.9, 1.2, (0.9, 1.1), 0.5),
        ctc.AlignedWord("sing", 1.3, 2.1, (), following_score),
        ctc.AlignedWord("together", 2.3 + anchor_shift, 2.8 + anchor_shift, (), 0.8),
    ]

    result = recover_weak_cue_entries(
        words, [(0, 0.8, "we sing together")], [0.9], lambda *_: candidate
    )

    assert result[-1] == words[-1]
    if accepted:
        assert [word.start for word in result[:2]] == [0.9, 1.3]
        assert all("OnsetRecovered" in word.diagnostics for word in result[:2])
    else:
        assert result == words
