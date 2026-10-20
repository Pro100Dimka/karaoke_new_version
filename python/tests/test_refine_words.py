from __future__ import annotations

import pytest

from backend.ai.domain import PitchPoint, WordTiming
from backend.processing.algorithms import MusicMetadata, construct_document


def _pitch(times: list[float]) -> list[PitchPoint]:
    return [PitchPoint(time, 220.0, 0.9) for time in times]


@pytest.mark.parametrize(
    "word,times",
    [
        (WordTiming("бой", 10.0, 11.0, 1.0, (10.0, 10.05, 10.6)), [10.3, 10.4, 10.7]),
        (
            WordTiming("Скрой", 83.61, 84.11, 1.0, (83.61, 83.69, 83.79, 83.89, 84.03)),
            [83.88, 83.95, 84.1],
        ),
        (
            WordTiming(
                "сказав.",
                102.44,
                105.89,
                1.0,
                (102.44, 102.537, 102.737, 103.157, 103.297, 105.759, 105.779),
            ),
            [102.5, 102.7, 103.0, 103.2, 105.5, 105.7, 105.759],
        ),
        (WordTiming("тишина", 5.0, 6.0, 1.0, (5.0, 5.2, 5.4, 5.6, 5.8, 5.9)), []),
        (WordTiming("О", 5.0, 5.5, 1.0, (5.0,)), [5.2, 5.3, 5.4]),
        (WordTiming("О", 5.0, 5.5, 1.0, (5.0,)), [5.02, 5.1, 5.2]),
    ],
)
def test_pitch_refinement_preserves_aligned_words_and_every_letter(word, times) -> None:
    # Tonal vowel estimates cannot establish consonant starts/ends or repair the alignment.
    document = construct_document(
        "t", "a", word.end, word.text, [word], _pitch(times), MusicMetadata(None, None)
    )
    actual = document.words[0]
    assert (actual.text, actual.start, actual.end, actual.letters) == (
        word.text,
        word.start,
        word.end,
        word.letters,
    )


def test_pitch_cannot_move_independently_aligned_word_and_consonant_boundaries() -> None:
    word = WordTiming("стоп", 5.0, 6.0, 0.9, (5.0, 5.1, 5.3, 5.8))
    document = construct_document(
        "t", "a", 6.0, word.text, [word], _pitch([5.3, 5.4, 5.5]), MusicMetadata(None, None)
    )
    assert (document.words[0].start, document.words[0].end, document.words[0].letters) == (
        word.start,
        word.end,
        word.letters,
    )
