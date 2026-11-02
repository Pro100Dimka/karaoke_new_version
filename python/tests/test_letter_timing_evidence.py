from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest
import torch
from torchaudio.pipelines import MMS_FA

from backend.ai.domain import WordTiming
from backend.ai_worker.ctc import AlignedWord, _character_tokens, align_words, with_sung_letters
from backend.ai_worker.recognition import alignment_payload
from backend.ai_worker.timing import singing_frames
from backend.processing.reporting import alignment_warnings


def _emissions(text: str, frames: tuple[int, ...]) -> tuple[torch.Tensor, list[int]]:
    tokens = [token for character in _character_tokens(text) for token in character]
    size = len(MMS_FA.get_dict(star=None))
    probabilities = torch.full((85, size), 0.2 / (size - 1))
    probabilities[:, 0] = 0.8
    for frame, token in zip(frames, tokens, strict=True):
        probabilities[frame] = 0.05 / (size - 1)
        probabilities[frame, token] = 0.95
    return probabilities, tokens


def test_real_disagreeing_odin_letters_remain_explicitly_unresolved() -> None:
    # Recorded v3 output, not a phonetic reference. The paired cached emissions
    # disagree by 320/400 ms on и/н, but their probabilities are too weak to repair.
    with np.load(Path(__file__).with_name("fixtures") / "wildways-verse-entry.npz") as fixture:
        scores = torch.from_numpy(fixture["clean_entry_scores"])
        vocal = fixture["clean_entry_vocal"].astype(np.float32)
        backing = fixture["clean_entry_instrumental"].astype(np.float32)
    word = AlignedWord("один", 8.62, 9.94, (8.62, 9.36, 9.38, 9.40), 0.0019060261965933023)
    fixed = with_sung_letters(
        [word], scores, 0.02, singing_frames(vocal, backing, 16_000, 160), {0: (8.62, 9.94)}
    )[0]

    assert (fixed.start, fixed.end, fixed.letters, fixed.score) == (
        word.start,
        word.end,
        word.letters,
        word.score,
    )
    assert "LetterTimingReviewRequired" in fixed.diagnostics
    assert "ApproximateLetterTiming" in fixed.diagnostics
    payload = alignment_payload([fixed], {0: (8.62, 9.94)})["words"][0]
    assert "LetterTimingReviewRequired" in payload["diagnostics"]
    warnings = alignment_warnings(
        [
            WordTiming(
                fixed.text, fixed.start, fixed.end, fixed.score, fixed.letters, fixed.diagnostics
            )
        ]
    )
    assert any("LetterTimingReviewRequired" in warning for warning in warnings)


@pytest.mark.parametrize("text", ["один", "світ"])
def test_confirmed_joint_suffix_repair_does_not_freeze_a_collapsed_vowel(text: str) -> None:
    # The local ordinary and bounded paths agree on the vowel at .6. The final
    # consonant is strongly supported at 1.2, and both stale positions are weak.
    probabilities, _ = _emissions(text, (10, 12, 30, 60))
    word = AlignedWord(text, 0.2, 1.22, (0.2, 0.24, 0.28, 0.30), 0.1)

    fixed = with_sung_letters(
        [word], probabilities.log(), 0.02, np.ones(170, bool), {0: (0.2, 1.22)}
    )[0]

    assert fixed.letters == pytest.approx((0.2, 0.24, 0.60, 1.20))
    assert (fixed.start, fixed.end) == (word.start, word.end)
    assert fixed.letters[:2] == word.letters[:2]


def test_a_strong_tail_cannot_authorize_an_unsupported_prefix_change() -> None:
    probabilities, tokens = _emissions("один", (10, 12, 30, 60))
    probabilities[30] = 0.05 / (probabilities.shape[-1] - 2)
    probabilities[30, 0] = 0.91
    probabilities[30, tokens[2]] = 0.04
    word = AlignedWord("один", 0.2, 1.22, (0.2, 0.24, 0.28, 0.30), 0.1)

    fixed = with_sung_letters(
        [word], probabilities.log(), 0.02, np.ones(170, bool), {0: (0.2, 1.22)}
    )[0]

    assert fixed.letters == word.letters
    assert "LetterTimingReviewRequired" in fixed.diagnostics


def test_agreeing_local_paths_can_replace_an_unsupported_stored_suffix() -> None:
    probabilities, tokens = _emissions("один", (10, 12, 30, 60))
    probabilities[:] = 0.001 / (probabilities.shape[-1] - 1)
    probabilities[:, 0] = 0.999
    for frame, token in zip((10, 12, 30, 60), tokens, strict=True):
        probabilities[frame] = 0.05 / (probabilities.shape[-1] - 1)
        probabilities[frame, token] = 0.95
    word = AlignedWord("один", 0.2, 1.22, (0.2, 0.24, 0.28, 0.30), 0.1)

    fixed = with_sung_letters(
        [word], probabilities.log(), 0.02, np.ones(170, bool), {0: (0.2, 1.22)}
    )[0]

    assert fixed.letters == pytest.approx((0.2, 0.24, 0.60, 1.20))
    assert (fixed.start, fixed.end) == (word.start, word.end)


def test_one_subtoken_cannot_certify_retiming_a_whole_multitoken_grapheme() -> None:
    # ч has two romanized tokens. The single-token suffix rule cannot establish
    # the acoustic boundary of the whole affricate from only its first subtoken.
    probabilities, _ = _emissions("очень", (10, 30, 31, 40, 60))
    word = AlignedWord("очень", 0.2, 1.22, (0.2, 0.24, 0.28, 0.30, 0.32), 0.1)

    fixed = with_sung_letters(
        [word], probabilities.log(), 0.02, np.ones(170, bool), {0: (0.2, 1.22)}
    )[0]

    assert fixed.letters == word.letters
    assert "ApproximateLetterTiming" in fixed.diagnostics


@pytest.mark.parametrize("text", ["дом", "дім", "сон"])
def test_a_genuinely_held_nasal_retains_its_early_onset(text: str) -> None:
    probabilities, tokens = _emissions(text, (10, 12, 14))
    probabilities[14:61] = 0.05 / (probabilities.shape[-1] - 1)
    probabilities[14:61, tokens[-1]] = 0.95
    word = replace(align_words(probabilities.log(), 0.02, [text])[0], end=1.22)

    fixed = with_sung_letters(
        [word], probabilities.log(), 0.02, np.ones(170, bool), {0: (0.2, 1.22)}
    )[0]

    assert fixed == word
    assert word.letters[-1] == 0.28


@pytest.mark.parametrize("text", ["дом", "дім"])
def test_a_genuinely_fast_word_has_no_sustained_letter_repair(text: str) -> None:
    probabilities, _ = _emissions(text, (10, 11, 12))
    word = align_words(probabilities.log(), 0.01, [text])[0]

    fixed = with_sung_letters(
        [word], probabilities.log(), 0.01, np.ones(85, bool), {0: (0.1, 0.13)}
    )[0]

    assert fixed == word
    assert fixed.end - fixed.start == pytest.approx(0.03)


def test_silence_before_a_later_echo_prevents_a_suffix_repair() -> None:
    probabilities, _ = _emissions("один", (10, 12, 30, 60))
    word = AlignedWord("один", 0.2, 1.22, (0.2, 0.24, 0.28, 0.30), 0.1)
    activity = np.ones(170, bool)
    activity[65:100] = False

    assert with_sung_letters([word], probabilities.log(), 0.02, activity, {0: (0.2, 1.22)}) == [
        word
    ]


def test_a_joint_letter_repair_preserves_a_legato_neighbour() -> None:
    probabilities, _ = _emissions("один", (10, 12, 30, 60))
    word = AlignedWord("один", 0.2, 1.22, (0.2, 0.24, 0.28, 0.30), 0.1)
    following = AlignedWord("я", 1.22, 1.4, (1.22,), 0.9)

    fixed = with_sung_letters([word, following], probabilities.log(), 0.02, np.ones(170, bool), {})

    assert fixed[0].letters == pytest.approx((0.2, 0.24, 0.60, 1.20))
    assert (fixed[0].start, fixed[0].end) == (word.start, word.end)
    assert fixed[1] == following


@pytest.mark.parametrize(
    "text,frames",
    [
        ("мама", (10, 12, 14, 30)),
        ("мамо", (10, 12, 14, 30)),
        ("дом", (10, 12, 30)),
        ("дім", (10, 12, 30)),
    ],
)
def test_collapsed_sounding_suffix_uses_only_a_marked_local_estimate(
    text: str, frames: tuple[int, ...]
) -> None:
    # A real pause fixed the word end; clamping a late CTC token collapsed its
    # last sound. Reuse a local path only when every retained prefix anchor agrees.
    probabilities, _ = _emissions(text, frames)
    expected = tuple(frame * 0.02 for frame in frames)
    word = AlignedWord(text, 0.2, 1.2, (*expected[:-1], 1.2), 0.4)
    activity = np.zeros(170, bool)
    activity[20:120] = True

    fixed = with_sung_letters([word], probabilities.log(), 0.02, activity, {})[0]

    assert fixed.letters == pytest.approx(expected)
    assert (fixed.start, fixed.end) == (word.start, word.end)
    assert fixed.letters[:-1] == word.letters[:-1]
    assert fixed.score <= word.score
    assert "ApproximateLetterTiming" in fixed.diagnostics
    assert "LetterTimingReviewRequired" in fixed.diagnostics
    assert "SungConsonantRetimed" not in fixed.diagnostics
    payload = alignment_payload([fixed], {})["words"][0]
    assert "ApproximateLetterTiming" in payload["diagnostics"]


@pytest.mark.parametrize("missing_evidence", ["pause", "stable-prefix"])
def test_collapsed_sounding_suffix_without_support_stays_explicitly_unresolved(
    missing_evidence: str,
) -> None:
    probabilities, _ = _emissions("мама", (10, 12, 14, 30))
    prefix = (0.2, 0.24, 0.28) if missing_evidence == "pause" else (0.2, 0.4, 0.5)
    word = AlignedWord("мама", 0.2, 1.2, (*prefix, 1.2), 0.4)
    activity = np.ones(170, bool)
    if missing_evidence == "stable-prefix":
        activity[120:] = False

    fixed = with_sung_letters([word], probabilities.log(), 0.02, activity, {})[0]

    assert (fixed.start, fixed.end, fixed.letters, fixed.score) == (
        word.start,
        word.end,
        word.letters,
        word.score,
    )
    assert "ApproximateLetterTiming" in fixed.diagnostics
    assert "LetterTimingReviewRequired" in fixed.diagnostics


def test_collapsed_sounding_review_does_not_treat_a_soft_sign_as_a_sound() -> None:
    probabilities, _ = _emissions("соль", (10, 12, 14))
    word = AlignedWord("соль", 0.2, 1.2, (0.2, 0.24, 0.28, 1.2), 0.4)
    assert with_sung_letters([word], probabilities.log(), 0.02, np.ones(170, bool), {}) == [word]


def test_collapsed_sounding_review_keeps_real_fast_vowels() -> None:
    probabilities, _ = _emissions("мамо", (10, 11, 12, 13))
    word = align_words(probabilities.log(), 0.01, ["мамо"])[0]
    assert with_sung_letters([word], probabilities.log(), 0.01, np.ones(170, bool), {}) == [word]


def test_collapsed_sounding_suffix_with_weak_ctc_remains_an_approximation() -> None:
    probabilities, tokens = _emissions("мамо", (10, 12, 14, 30))
    probabilities[:] = 0.001 / (probabilities.shape[-1] - 1)
    probabilities[:, 0] = 0.999
    for frame, token in zip((10, 12, 14), tokens[:-1], strict=True):
        probabilities[frame] = 0.05 / (probabilities.shape[-1] - 1)
        probabilities[frame, token] = 0.95
    probabilities[30] = 0.003 / (probabilities.shape[-1] - 2)
    probabilities[30, 0] = 0.995
    probabilities[30, tokens[-1]] = 0.002
    word = AlignedWord("мамо", 0.2, 1.2, (0.2, 0.24, 0.28, 1.2), 0.1)
    activity = np.zeros(170, bool)
    activity[20:120] = True

    fixed = with_sung_letters([word], probabilities.log(), 0.02, activity, {})[0]

    assert fixed.letters == pytest.approx((0.2, 0.24, 0.28, 0.6))
    assert (fixed.start, fixed.end) == (word.start, word.end)
    assert fixed.score <= word.score
    assert "ApproximateLetterTiming" in fixed.diagnostics
    assert "LetterTimingReviewRequired" in fixed.diagnostics
