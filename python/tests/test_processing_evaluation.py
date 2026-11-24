from dataclasses import replace

import pytest

pytest.importorskip("jiwer", reason="Requires the optional evaluation dependencies")
pytest.importorskip("mir_eval", reason="Requires the optional evaluation dependencies")

from backend.lyrics.domain import LyricsDocument, Note, Word
from scripts.evaluate_processing import evaluate


def document(words: tuple[Word, ...]) -> LyricsDocument:
    return LyricsDocument("Fixture", "", 3, None, None, "", words)


def test_missing_words_and_pitch_remain_in_denominators() -> None:
    reference = document(
        (
            Word("one", 0, 1, (Note(60, 0, 1),)),
            Word("two", 1, 2, (Note(60, 1, 2),)),
        )
    )
    result = evaluate(reference, document((reference.words[0],)))
    assert result["text"]["wer"] == 0.5
    assert result["timing"]["matchedReferenceFraction"] == 0.5
    assert result["pitch"]["Raw Pitch Accuracy"] == pytest.approx(0.5)


def test_octave_error_is_not_reported_as_correct_pitch() -> None:
    reference = document((Word("one", 0, 2, (Note(60, 0, 2),)),))
    estimated = document((Word("one", 0, 2, (Note(72, 0, 2),)),))
    result = evaluate(reference, estimated)
    assert result["pitch"]["Raw Pitch Accuracy"] == 0
    assert result["pitch"]["Raw Chroma Accuracy"] == 1


def test_boundary_and_letter_errors_are_measured_without_global_shift() -> None:
    word = Word("one", 0, 1, (), (0, 0.3, 0.7))
    shifted = replace(word, start=0.2, end=1.2, letters=(0.2, 0.5, 0.9))
    result = evaluate(document((word,)), document((shifted,)))
    for key in ("start", "end", "letters"):
        assert result["timing"][key]["medianMs"] == pytest.approx(200)
        assert result["timing"][key]["within100Ms"] == 0
    assert result["pitch"] is None


def test_empty_letter_evidence_does_not_become_zero_error() -> None:
    word = Word("one", 0, 1, (), (0, 0.3, 0.7))
    result = evaluate(document((word,)), document((replace(word, letters=()),)))
    assert result["timing"]["letters"] is None
    assert result["timing"]["comparedLetterFraction"] == 0


def test_text_case_is_normalized_but_different_letters_are_preserved() -> None:
    reference = document((Word("Кофе", 0, 1, ()), Word("її", 1, 2, ())))
    estimated = document((Word("кофе", 0, 1, ()), Word("іі", 1, 2, ())))
    result = evaluate(reference, estimated)
    assert result["text"]["wer"] == 0.5
    assert result["timing"]["matchedWords"] == 1


def test_different_recording_durations_are_rejected() -> None:
    reference = document(())
    with pytest.raises(ValueError, match="duration"):
        evaluate(reference, replace(reference, duration=4))


def test_extra_notes_in_rests_are_counted() -> None:
    reference = document((Word("one", 0, 1, (Note(60, 0, 1),)),))
    estimated = document((Word("one", 0, 2, (Note(60, 0, 2),)),))
    assert evaluate(reference, estimated)["pitch"]["Voicing False Alarm"] == pytest.approx(0.5)


def test_repeated_words_are_not_deduplicated() -> None:
    reference = document((Word("да", 0, 1, ()), Word("да", 1, 2, ())))
    result = evaluate(reference, document((reference.words[0],)))
    assert result["text"]["deletions"] == 1


def test_window_excludes_deferred_material_without_shifting_timeline() -> None:
    reference = document((Word("one", 0, 1, (Note(60, 0, 1),)), Word("two", 2, 3, ())))
    result = evaluate(reference, document((reference.words[0],)), start=0, end=1.5)
    assert result["text"]["wer"] == 0
    assert result["pitch"]["Raw Pitch Accuracy"] == 1


@pytest.mark.parametrize("start,end", [(-1, 2), (2, 1), (0, 4)])
def test_invalid_windows_are_rejected(start: float, end: float) -> None:
    with pytest.raises(ValueError, match="window"):
        evaluate(document(()), document(()), start=start, end=end)


def test_window_metrics_do_not_add_an_unobserved_frame_at_zero() -> None:
    reference = document((Word("one", 0.5, 1, (Note(60, 0.5, 1),)),))
    estimated = document((Word("one", 0.5, 1.5, (Note(60, 0.5, 1.5),)),))
    result = evaluate(reference, estimated, start=0.5, end=1.5)
    assert result["pitch"]["Overall Accuracy"] == 0.5
