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


@pytest.mark.parametrize("text", [("дом", "мой"), ("дім", "мій")])
def test_corrected_joint_word_boundary_restores_held_note_without_changing_melody(text) -> None:
    from backend.lyrics.codec import decode_document, encode_document

    pitch = [PitchPoint(i / 100, 220.0, 0.99, True) for i in range(150)]
    pitch += [PitchPoint(i / 100, 0.0, 0.0, False) for i in range(150, 200)]
    compressed = (
        WordTiming(text[0], 0.0, 0.1, 0.9, (0.0, 0.03, 0.09)),
        WordTiming(text[1], 0.1, 1.5, 0.5, (0.1, 1.05, 1.4)),
    )
    corrected = (
        WordTiming(text[0], 0.0, 1.0, 0.9, (0.0, 0.03, 0.95)),
        WordTiming(text[1], 1.0, 1.5, 0.9, (1.0, 1.05, 1.4)),
    )
    before, after = (
        construct_document("t", "a", 2.0, "\n".join(text), words, pitch, MusicMetadata(None, None))
        for words in (compressed, corrected)
    )

    assert before.words[0].notes[0].end == 0.1
    assert [(note.note, note.start, note.end) for word in after.words for note in word.notes] == [
        (57, 0.0, 1.0),
        (57, 1.0, 1.5),
    ]
    assert [word.letters for word in after.words] == [word.letters for word in corrected]
    # The same measured melody/analysis timeline survives reassignment to the right word.
    assert list(after.target_frames()) == list(before.target_frames())
    assert decode_document(encode_document(after)) == after
    for word in after.words:
        note = word.notes[0]
        measured_times = [
            note.start + fraction * (note.end - note.start) for fraction, _, _ in note.contour
        ]
        assert measured_times == pytest.approx(
            [point.time for point in pitch if note.start <= point.time < note.end]
        )


@pytest.mark.parametrize("text,fast", [("дом", "и"), ("дім", "і")])
def test_repeated_words_keep_distinct_holds_and_fast_word_does_not_fill_silence(text, fast) -> None:
    words = (
        WordTiming(text, 0.0, 1.0, 0.9, (0.0, 0.03, 0.95)),
        WordTiming(text, 2.0, 3.65, 0.9, (2.0, 2.03, 3.6)),
        WordTiming(fast, 3.65, 3.72, 0.9, (3.65,)),
    )
    pitch = [
        PitchPoint(i / 100, 220.0 if active else 0.0, 0.99 if active else 0.0, active)
        for i in range(400)
        for active in [i < 100 or 200 <= i < 372]
    ]
    document = construct_document(
        "t", "a", 4.0, f"{text}\n{text} {fast}", words, pitch, MusicMetadata(None, None)
    )

    assert [word.end - word.start for word in document.words] == pytest.approx([1.0, 1.65, 0.07])
    for word, expected in zip(document.words, [(0.0, 1.0), (2.0, 3.65), (3.65, 3.72)], strict=True):
        assert (word.notes[0].start, word.notes[-1].end) == pytest.approx(expected)
    assert all(
        pitch is None and not active
        for time, pitch, active in document.target_frames()
        if 1.0 <= time < 1.99 or 3.73 <= time
    )
