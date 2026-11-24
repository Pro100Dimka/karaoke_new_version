import numpy as np
import pytest
import torch

from backend.ai_worker import ctc
from backend.ai_worker.acoustic_retry import recover_emission
from backend.ai_worker.ctc import AlignedWord
from backend.ai_worker.lead_vocals import backing_overlap_indices, with_lead_vocals
from backend.ai_worker.speech_alignment import _AlignmentPass
from tests.test_asr_recovery import _scores


@pytest.mark.parametrize("text", ["оно", "сама", "alone"])
@pytest.mark.parametrize("stable_context", [False, True])
def test_recovered_entry_uses_phonemes_when_its_following_context_stays_in_place(
    text, stable_context
):
    step = 0.02
    words = [
        AlignedWord(
            text,
            1,
            2,
            tuple(np.linspace(1, 2, len(text), endpoint=False)),
            0.8,
            ("IndependentLeadEntry", "ApproximateLetterTiming"),
        ),
        AlignedWord("не", 2, 2.4, (2, 2.2), 0.8),
        AlignedWord("уйдёт", 2.4, 3.6, (2.4, 2.6, 2.8, 3, 3.2), 0.8),
    ]
    shift = 0 if stable_context else 0.6
    scores = _scores(
        [(text, 1.4, 0.95), ("не", 2.04 + shift, 0.95), ("уйдёт", 2.44 + shift, 0.95)], duration=4
    )
    audio = np.arange(4 * 16_000, dtype=np.float32)
    pass_ = _AlignmentPass(
        audio, None, scores, step, [w.text for w in words], " ".join(w.text for w in words), [], []
    )
    pass_.emit = lambda samples: (
        scores[round(float(samples[0]) / 320) : round((float(samples[0]) + len(samples)) / 320)],
        step,
    )

    payload = pass_._finish_alignment(
        words,
        np.ones(401, bool),
        (np.ones((401, 16)), np.ones(401)),
        lambda _contexts: {},
        frozenset(),
        {},
    )

    assert payload["words"][0]["start"] == pytest.approx(1.4 if stable_context else 1)
    assert payload["words"][0]["end"] == 2
    assert [(w["start"], w["end"]) for w in payload["words"][1:]] == [(2, 2.4), (2.4, 3.6)]


@pytest.mark.parametrize("text", ["please", "прошу"])
@pytest.mark.parametrize(
    "evidence",
    ["earlier_sequence", "absent", "earlier_chorus", "other_predecessor", "one_view"],
)
def test_late_ctc_slot_does_not_make_an_independently_heard_lead_word_backing(text, evidence):
    if evidence == "earlier_sequence":
        _assert_acoustically_repaired_lead(text)
        return
    words = [
        AlignedWord("hold", 2, 4, (2, 2.3, 2.5, 2.7), 0.8),
        AlignedWord(text, 4, 4.2, (), 0.2),
        AlignedWord("let", 4.2, 4.6, (), 0.8),
        AlignedWord("me", 4.6, 5, (), 0.8),
        AlignedWord("go", 5, 5.3, (), 0.8),
        AlignedWord("forever", 5.3, 6, (), 0.8),
    ]
    lead = [("let", 3.4, 4.6), ("me", 4.6, 5), ("go", 5, 5.3), ("forever", 5.3, 6)]
    predecessor = "other" if evidence == "other_predecessor" else "hold"
    view = [(predecessor, 2, 2.6)]
    if evidence in {"earlier_sequence", "other_predecessor", "one_view"}:
        view.append((text, 2.8, 3.2))
    if evidence == "earlier_chorus":
        view.insert(0, (text, 0.2, 0.7))
    view.extend(lead)
    views = [view, list(view)]
    if evidence == "one_view":
        views[1] = [item for item in views[1] if item[0] != text]

    activity = np.ones(700, dtype=bool)
    periodicity = np.ones(700)
    backing = backing_overlap_indices(words, views, activity, periodicity)

    # An earlier chorus, a different phrase, or only one matching view is not
    # enough to rescue an extra word that obstructs the independently heard lead.
    assert backing == frozenset({1})


def _lead_emission(words, *, recovered):
    values = torch.full((350, 28), 1e-8)
    values[:, 0] = 1
    scores = (values / values.sum(dim=1, keepdim=True)).log()
    starts = [1, 2, 2.8 if recovered else 4, 3.4 if recovered else 4.2, 4.6, 5, 5.3]
    for index, (word, start) in enumerate(zip(words, starts, strict=True)):
        tokens = [
            token for letters in ctc._character_tokens(word, " ".join(words)) for token in letters
        ]
        times = [start + number * 0.02 for number in range(len(tokens))]
        if index == 1 and not recovered:
            times[-1] = 3.98
        for token, moment in zip(tokens, times, strict=True):
            frame = round(moment / 0.02)
            row = torch.full_like(scores[frame], 1e-8)
            row[0], row[token] = 0.1, 0.9
            scores[frame] = (row / row.sum()).log()
    return scores


def _assert_acoustically_repaired_lead(text):
    words = ["now", "hold", text, "let", "me", "go", "forever"]
    old, new = _lead_emission(words, recovered=False), _lead_emission(words, recovered=True)
    view = [
        ("now", 1, 1.3),
        ("hold", 2, 2.6),
        (text, 2.8, 3.2),
        ("let", 3.4, 4.6),
        ("me", 4.6, 5),
        ("go", 5, 5.3),
        ("forever", 5.3, 6),
    ]
    views = [view, list(view)]
    activity, periodicity = np.ones(700, dtype=bool), np.ones(700)
    original = ctc.align_words(old, 0.02, words)
    assert backing_overlap_indices(original, views, activity, periodicity) == frozenset({2})
    calls = []

    def emit(audio):
        first = round(float(audio[0]) / 320)
        calls.append((first, len(audio)))
        return new[first : first + round(len(audio) / 320)], 0.02

    audio = np.arange(7 * 16_000, dtype=np.float32)
    result = recover_emission(audio, old, 0.02, " ".join(words), views, emit)
    repaired = ctc.align_words(result, 0.02, words)
    assert len(calls) == 1
    assert repaired[2].start == pytest.approx(2.8)
    assert repaired[2].letters and max(repaired[2].letters) < 3.2
    assert backing_overlap_indices(repaired, views, activity, periodicity) == frozenset()
    assert with_lead_vocals(repaired, views, activity, periodicity) is repaired
