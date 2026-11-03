from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest
import torch

from backend.ai_worker import ctc, speech, word_guidance
from backend.ai_worker.guidance_windows import _REVIEW_MAX_SECONDS


_STEP = 0.02


def _case(text="вдруг"):
    """A weak stray opening token, followed by a correctly aligned phonetic body."""
    letters = (0.18, *(round(at / _STEP) * _STEP for at in np.linspace(1.02, 1.44, len(text) - 1)))
    cores = [
        ctc.AlignedWord(text, letters[0], 1.46, letters),
        ctc.AlignedWord("там", 1.8, 2.2, (1.8, 1.9, 2.18)),
    ]
    scores = torch.full((160, 28), np.log(1e-6))
    scores[:, 0] = np.log(0.99)
    for word in cores:
        for at, tokens in zip(word.letters, ctc._character_tokens(word.text), strict=True):
            for offset, token in enumerate(tokens):
                frame = round(at / _STEP) + offset
                scores[frame, 0] = np.log(0.01)
                scores[frame, token] = np.log(0.99)
    opening = ctc._character_tokens(text)[0][0]
    scores[9, opening], scores[9, 0] = np.log(0.03), np.log(0.99)
    scores[46, opening] = np.log(0.029)
    words = ctc.align_words(scores, _STEP, [word.text for word in cores])
    activity = np.zeros(320, dtype=bool)
    activity[92:146] = True
    activity[180:220] = True
    return words, scores, activity


def _guide(words, scores, activity, *, reviewed=frozenset(), heard=None):
    return word_guidance.with_word_guidance(
        words, scores, _STEP, [], heard or {}, activity, 0.6, reviewed=reviewed
    )


@pytest.mark.parametrize("text", ["вдруг", "вдома"])
def test_a_weak_opening_in_silence_is_flagged_before_onset_normalization(text):
    words, scores, activity = _case(text)

    flagged = _guide(words, scores, activity)

    assert "OnsetReviewRequired" in flagged[0].diagnostics
    assert replace(flagged[0], diagnostics=()) == words[0]
    assert flagged[1:] == words[1:]


@pytest.mark.parametrize("text", ["вдруг", "вдома"])
def test_local_review_uses_an_active_phonetic_anchor_without_retiming_neighbours(text, monkeypatch):
    words, scores, activity = _case(text)
    flagged = _guide(words, scores, activity)
    calls = []
    align_window = ctc._align_window

    def record_window(emission, step, texts, window):
        calls.append(window)
        return align_window(emission, step, texts, window)

    monkeypatch.setattr(ctc, "_align_window", record_window)

    result = _guide(flagged, scores, activity, reviewed=frozenset({0}))

    assert result[0].start == pytest.approx(0.92)
    assert result[0].score < words[0].score  # Removing a false token need not raise the mean.
    assert result[0].letters[1:] == words[0].letters[1:]
    assert result[0].end == words[0].end
    assert result[1:] == words[1:]
    assert "OnsetReviewRequired" not in result[0].diagnostics
    assert len(calls) == 1
    assert calls[0].last - calls[0].first == 2
    assert calls[0].end - calls[0].start <= _REVIEW_MAX_SECONDS


@pytest.mark.parametrize("text", ["мир", "шум"])
def test_a_held_initial_nasal_or_fricative_is_not_cut_to_the_later_vowel(text):
    words, scores, activity = _case(text)
    activity[18:146] = True

    assert _guide(words, scores, activity) == words
    assert _guide(words, scores, activity, reviewed=frozenset({0})) == words


def test_strong_ctc_evidence_preserves_a_quiet_initial_consonant():
    words, scores, activity = _case()
    opening = ctc._character_tokens(words[0].text)[0][0]
    scores[9, opening] = np.log(0.9)
    words = ctc.align_words(scores, _STEP, [word.text for word in words])

    assert _guide(words, scores, activity) == words
    assert _guide(words, scores, activity, reviewed=frozenset({0})) == words


def test_an_intervening_active_sound_prevents_silent_prefix_recovery():
    words, scores, activity = _case()
    activity[40:55] = True

    assert _guide(words, scores, activity) == words
    assert _guide(words, scores, activity, reviewed=frozenset({0})) == words


@pytest.mark.parametrize("damage", ["suffix", "neighbour", "score", "fallback"])
def test_an_onset_repair_cannot_trade_away_supported_phonetic_context(monkeypatch, damage):
    words, scores, activity = _case()
    flagged = _guide(words, scores, activity)
    proposal = ctc._align_window(
        scores, _STEP, [word.text for word in words], ctc.Window(0, 2, 0.92, 2.8)
    )
    if damage == "suffix":
        proposal[0] = replace(proposal[0], letters=(0.92, 1.24, *proposal[0].letters[2:]))
    elif damage == "neighbour":
        proposal[1] = replace(proposal[1], end=2.02)
    elif damage == "score":
        proposal[0] = replace(proposal[0], score=words[0].score * 0.9)
    else:
        proposal = ctc._evenly([word.text for word in words], 0.92, 2.8)
    monkeypatch.setattr(ctc, "_align_window", lambda *_: proposal)

    assert _guide(flagged, scores, activity, reviewed=frozenset({0})) == flagged


def test_an_onset_only_repair_keeps_an_unchanged_neighbours_frame_jitter(monkeypatch):
    words, scores, activity = _case()
    flagged = _guide(words, scores, activity)
    proposal = ctc._align_window(
        scores, _STEP, [word.text for word in words], ctc.Window(0, 2, 0.92, 2.8)
    )
    proposal[1] = replace(
        proposal[1],
        start=proposal[1].start + _STEP,
        letters=tuple(at + _STEP for at in proposal[1].letters),
        end=proposal[1].end + _STEP,
    )
    monkeypatch.setattr(ctc, "_align_window", lambda *_: proposal)

    result = _guide(flagged, scores, activity, reviewed=frozenset({0}))

    assert result[0].start == pytest.approx(0.92)
    assert result[1] == words[1]


def test_a_silent_prefix_review_does_not_override_an_independent_contradiction():
    words, scores, activity = _case()
    flagged = _guide(words, scores, activity)

    assert (
        _guide(flagged, scores, activity, reviewed=frozenset({0}), heard={0: (0.18, 1.46)})
        == flagged
    )


@pytest.mark.parametrize("text", ["дом", "дім"])
def test_a_genuinely_fast_word_keeps_its_short_duration(text):
    _, scores, activity = _case()
    word = ctc.AlignedWord(text, 0.92, 0.98, (0.92, 0.94, 0.96), 0.9)

    assert _guide([word], scores, activity) == [word]


def test_a_recovered_onset_is_stable_and_does_not_repeat_ctc(monkeypatch):
    words, scores, activity = _case()
    flagged = _guide(words, scores, activity)
    repaired = _guide(flagged, scores, activity, reviewed=frozenset({0}))

    def unexpected_alignment(*_args, **_kwargs):
        pytest.fail("An unchanged acoustic entry must not request another alignment")

    monkeypatch.setattr(ctc, "_align_window", unexpected_alignment)

    assert _guide(repaired, scores, activity) == repaired
    assert ctc.ordered(repaired)[0].letters == repaired[0].letters
    assert ctc.ordered(repaired)[0].start == repaired[0].start


def _committed_review(monkeypatch, original, recovered, onset=1.0):
    """Exercise the real onset calibration and final commit around supplied CTC cores."""
    neighbour = ctc.AlignedWord(
        "там",
        onset + 1.34,
        onset + 1.60,
        (onset + 1.34, onset + 1.44, onset + 1.54),
        0.8,
    )
    words = [original, neighbour]
    activity = np.zeros(round((onset + 2) * 100), dtype=bool)
    activity[round(onset * 100) : round(original.end * 100)] = True
    activity[round((onset + 1.20) * 100) : round(neighbour.end * 100)] = True
    audio = np.zeros(len(activity) * 160, dtype=np.float32)
    monkeypatch.setattr(speech, "read_mono", lambda *_: audio)
    monkeypatch.setattr(speech, "_alignment_evidence", lambda *_: (torch.zeros(1, 28), _STEP, []))
    monkeypatch.setattr(speech, "align_words", lambda *_: words)
    monkeypatch.setattr(speech, "align_guided", lambda *_, **__: words)
    monkeypatch.setattr(speech, "recover_leading_words", lambda _text, _words, heard, _asr: heard)
    monkeypatch.setattr(speech, "_alignment_windows", lambda *_: [])
    monkeypatch.setattr(speech, "contextual_guidance", lambda _words, windows, *_: (windows, {}))
    monkeypatch.setattr(speech, "singing_frames", lambda *_: activity)
    monkeypatch.setattr(speech, "voiced_frames", lambda *_: activity)
    monkeypatch.setattr(speech, "with_sung_ends", lambda words, *_: words)
    monkeypatch.setattr(speech, "with_sung_letters", lambda words, *_: words)
    monkeypatch.setattr(speech, "rate_review_indices", lambda *_, **__: {0})
    monkeypatch.setattr(
        speech,
        "with_word_guidance",
        lambda words, *, reviewed=frozenset(), **_: [recovered, neighbour] if reviewed else words,
    )
    return speech.align(Path("vocal.wav"), f"{original.text} там", "Russian")["words"]


@pytest.mark.parametrize(
    "text,onset,letters,end,expected",
    [
        ("вдруг", 1.0, (0.18, 1.12, 1.30, 1.46, 1.62), 1.80, (1.0, 1.10, 1.16, 1.32, 1.48)),
        ("вдома", 4.0, (3.18, 4.12, 4.30, 4.46, 4.62), 4.80, (4.0, 4.10, 4.16, 4.32, 4.48)),
        ("шепіт", 1.0, (0.20, 1.30, 1.48, 1.62, 1.78), 1.94, (1.0, 1.16, 1.34, 1.48, 1.64)),
    ],
)
def test_onset_only_commit_preserves_supported_calibrated_letters(
    monkeypatch, text, onset, letters, end, expected
):
    original = ctc.AlignedWord(text, letters[0], end, letters, 0.72)
    recovered = replace(
        original,
        start=onset + 0.02,
        letters=(onset + 0.02, *letters[1:]),
        score=0.70,
        diagnostics=("OnsetRecovered",),
    )

    result = _committed_review(monkeypatch, original, recovered, onset)

    assert result[0]["letters"] == pytest.approx(expected)
    assert result[0]["start"] == onset
    assert result[0]["end"] == original.end
    assert result[0]["confidence"] == recovered.score
    assert "ApproximateLetterTiming" in result[0]["diagnostics"]
    assert "LetterTimingReviewRequired" in result[0]["diagnostics"]
    assert result[1]["start"] == pytest.approx(onset + 1.20)
    assert result[1]["letters"] == pytest.approx((onset + 1.20, onset + 1.30, onset + 1.40))


def test_a_separately_changed_raw_letter_keeps_its_new_calibrated_anchor(monkeypatch):
    original = ctc.AlignedWord("вдома", 0.18, 1.80, (0.18, 1.12, 1.30, 1.46, 1.62), 0.72)
    recovered = replace(
        original,
        start=1.02,
        letters=(1.02, 1.12, 1.28, 1.46, 1.62),
        diagnostics=("OnsetRecovered",),
    )

    result = _committed_review(monkeypatch, original, recovered)[0]

    assert result["letters"] == pytest.approx((1.0, 1.10, 1.26, 1.32, 1.48))


@pytest.mark.parametrize("changed", [1.338, 1.34, 1.42])
def test_crossed_or_newly_tied_calibrated_anchors_keep_the_complete_candidate(monkeypatch, changed):
    original = ctc.AlignedWord("вдруг", 0.18, 1.80, (0.18, 1.12, 1.30, 1.46, 1.62), 0.72)
    recovered = replace(
        original,
        start=1.02,
        letters=(1.02, 1.12, changed, 1.46, 1.62),
        diagnostics=("OnsetRecovered",),
    )

    result = _committed_review(monkeypatch, original, recovered)[0]

    assert result["letters"] == pytest.approx((1.0, 1.10, changed - 0.02, 1.44, 1.60))
    assert "ApproximateLetterTiming" in result["diagnostics"]
    assert "LetterTimingReviewRequired" in result["diagnostics"]


@pytest.mark.parametrize("scope", ["ordinary_review", "changed_end"])
def test_anchor_preservation_is_limited_to_an_onset_only_recovery(monkeypatch, scope):
    original = ctc.AlignedWord("вдома", 0.18, 1.80, (0.18, 1.12, 1.30, 1.46, 1.62), 0.72)
    recovered = replace(
        original,
        start=1.02,
        letters=(1.02, *original.letters[1:]),
        diagnostics=("OnsetRecovered",) if scope == "changed_end" else (),
        end=1.90 if scope == "changed_end" else original.end,
    )

    result = _committed_review(monkeypatch, original, recovered)[0]

    assert result["letters"] == pytest.approx((1.0, 1.10, 1.28, 1.44, 1.60))
    assert result["end"] == recovered.end
    assert "ApproximateLetterTiming" not in result.get("diagnostics", [])


@pytest.mark.parametrize("text", ["день,", "тінь."])
def test_existing_silent_character_ties_remain_valid_during_anchor_preservation(text):
    original = ctc.AlignedWord(text, 0.2, 1.8, (0.2, 1.2, 1.4, 1.6, 1.6), 0.8)
    core = replace(
        original, start=1.0, letters=(1.0, *original.letters[1:]), diagnostics=("OnsetRecovered",)
    )
    started = replace(original, start=0.1, letters=(0.1, 1.1, 1.3, 1.5, 1.5))
    candidate = replace(core, start=0.99, letters=(0.99, 1.19, 1.39, 1.59, 1.59))

    result = speech._preserved_onset_letters(original, core, started, candidate)

    assert result.letters == (0.99, 1.1, 1.3, 1.5, 1.5)
    assert result.start == candidate.start
    assert result.end == candidate.end
    assert "ApproximateLetterTiming" in result.diagnostics
