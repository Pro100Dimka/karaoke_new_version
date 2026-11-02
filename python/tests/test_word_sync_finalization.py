from __future__ import annotations

import pytest
import numpy as np

from backend.ai.domain import PitchPoint
from backend.ai_worker.ctc import AlignedWord, _clamped_letters, _evenly, ordered, with_voice_onsets
from backend.ai_worker.recognition import alignment_payload, rate_review_indices
from backend.infrastructure.command_ai_provider import _word
from backend.lyrics.codec import decode_document, encode_document
from backend.processing.algorithms import MusicMetadata, construct_document
from backend.processing.reporting import alignment_warnings
from tools.audit_lyrics_sync import audit


@pytest.mark.parametrize("text", [("дом", "там", "да"), ("дім", "там", "так")])
def test_unaligned_neighbour_cannot_clip_a_supported_core(text):
    source = [
        AlignedWord(text[0], 1.0, 1.3, (1.0, 1.06, 1.22), 0.9),
        AlignedWord(text[1], 1.1, 1.6, (1.1, 1.32, 1.5), 0.0),
        AlignedWord(text[2], 1.6, 1.9, (), 0.9),
    ]
    result = ordered(source)
    assert result[0] == source[0]
    assert (result[1].start, result[1].end) == (1.3, 1.6)
    assert "ApproximateLetterTiming" in result[1].diagnostics
    assert "BoundaryConflict" in result[1].diagnostics
    assert result[2] == source[2]
    assert ordered(result) == result


def test_proportional_fallback_never_claims_acoustic_letter_precision():
    words = _evenly(["мій", "дім"], 1.0, 2.0)
    payload = alignment_payload(ordered(words), {})["words"]
    assert all("ApproximateLetterTiming" in word["diagnostics"] for word in payload)
    assert all(word["confidence"] == 0 for word in payload)


def test_repeated_normalization_preserves_serialized_letter_anchors():
    source = [
        AlignedWord("дім", 8.155062988, 8.348778898, (8.155062988, 8.251920943, 8.347778898), 0.8),
        AlignedWord("я", 8.256459129, 9.0, (8.256459129,), 0.9),
    ]
    normalized = ordered(source)
    assert normalized[0].letters == (8.155, 8.252, 8.256)
    assert "ApproximateLetterTiming" in normalized[0].diagnostics
    assert "LetterTimingReviewRequired" in normalized[0].diagnostics
    assert ordered(normalized) == normalized


def test_coincident_letter_anchors_remain_explicitly_uncertain():
    word = AlignedWord("дім", 1.0, 1.3, (1.0, 1.3, 1.3), 0.8)
    result = ordered([word])
    assert result[0].letters == word.letters
    assert "ApproximateLetterTiming" in result[0].diagnostics
    assert "LetterTimingReviewRequired" in result[0].diagnostics
    assert ordered(result) == result


@pytest.mark.parametrize("text", ["нья", "нъя", "н'я", "н’я"])
@pytest.mark.parametrize("letters", [(1.0, 1.0, 1.5), (1.0, 1.5, 1.5)])
def test_silent_characters_share_anchors_without_becoming_sounding_ties(text, letters):
    word = AlignedWord(text, 1.0, 2.0, letters, 0.8)
    assert ordered([word]) == [word]


@pytest.mark.parametrize("text", ["нья", "нъя", "п'я", "п’я"])
def test_onset_refinement_does_not_move_sound_after_a_silent_character(text):
    word = AlignedWord(text, 0.0, 1.0, (0.0, 0.5, 0.5), 0.9)
    result = with_voice_onsets([word], np.empty(0), np.ones(200, dtype=bool))[0]
    assert result.letters == word.letters


@pytest.mark.parametrize("text", ["нья", "нъя", "п'я", "п’я"])
@pytest.mark.parametrize(
    ("shift", "start", "end", "expected"),
    [(0.0, 0.0, 0.9, (0.0, 0.5, 0.5)), (-0.1, 0.0, 1.0, (0.0, 0.4, 0.4))],
)
def test_letter_clamping_preserves_sounding_group_after_silent_character(
    text, shift, start, end, expected
):
    assert _clamped_letters((0.0, 0.5, 0.5), shift, start, end, text=text) == expected


def test_a_fallback_repair_cannot_push_a_following_supported_word():
    words = [
        AlignedWord("а", 1.0, 1.3, (1.0,), 0.9),
        AlignedWord("і", 1.1, 1.6, (1.1,), 0),
        AlignedWord("я", 1.2, 1.8, (1.2,), 0.9),
    ]
    result = ordered(words)
    assert result[2] == words[2]
    assert all(a.end <= b.start for a, b in zip(result, result[1:]))
    assert "BoundaryConflict" in result[0].diagnostics


def test_audit_requires_independent_occurrence_labels_for_accuracy():
    word = dict(text="дім", start=1.0, end=1.3, letters=[1.0, 1.06, 1.22], notes=[])
    document = dict(title="t", artist="a", duration=2, lyrics="дім", words=[word])
    assert audit(document)["summary"]["accuracy"] is None
    reference = dict(
        independent=True,
        source="manually labelled fixture",
        words=[dict(index=0, text="дім", start=1.1, end=1.5)],
    )
    result = audit(document, reference=reference)
    assert len(result["words"]) == 1
    assert result["summary"]["accuracy"]["medianMs"] == pytest.approx(150)
    assert result["summary"]["accuracy"]["maxMs"] == pytest.approx(200)
    with pytest.raises(ValueError, match="independent"):
        audit(document, reference={**reference, "independent": False})
    with pytest.raises(ValueError, match="occurrence"):
        audit(
            document, reference={**reference, "words": [{**reference["words"][0], "text": "інше"}]}
        )


def test_audit_reports_all_letters_and_unassigned_pitch_without_claiming_errors():
    document = dict(
        title="t",
        duration=2,
        lyrics="так",
        words=[
            dict(text="так", start=1.0, end=1.3, letters=[1.0, 1.1, 1.1], notes=[]),
        ],
    )
    point = dict(time=1.1, frequency=220, confidence=0.9, audioActive=True)
    result = audit(document, pitch={"points": [point]})
    assert len(result["words"][0]["letters"]) == 3
    assert result["summary"]["diagnostics"] == {"ZeroSoundingLetterCandidate": 1}
    assert result["summary"]["unassignedConfidentPitchPoints"] == [point]
    assert result["summary"]["accuracy"] is None


@pytest.mark.parametrize("text", [("дом", "там"), ("дім", "там")])
def test_material_normalization_loss_remains_visible_in_final_processing_report(text):
    source = [
        AlignedWord(text[0], 1.0, 1.3, (1.0, 1.06, 1.22), 0.9),
        AlignedWord(text[1], 1.1, 1.6, (1.1, 1.32, 1.5), 0.9),
    ]
    normalized = ordered(source)
    # Normalization alone cannot decide which acoustic core was wrong. Its loss
    # must survive a second pass and reach the report even without independent ASR.
    assert normalized[0].end - normalized[0].start == pytest.approx(0.1)
    assert "BoundaryConflict" in normalized[0].diagnostics
    assert ordered(normalized) == normalized
    reviewed = frozenset(rate_review_indices(normalized, " ".join(text)))
    assert 0 in reviewed
    payload = alignment_payload(normalized, {}, reviewed=reviewed)
    words = tuple(_word(item) for item in payload["words"])
    warnings = alignment_warnings(words, lyrics=" ".join(text))
    assert "AlignmentDiagnostic:wordIndex=0;BoundaryConflict" in warnings
    assert "AlignmentDiagnostic:wordIndex=0;TimingReviewRequired" in warnings

    document = construct_document(
        "t", "a", 2.0, " ".join(text), words, (), MusicMetadata(None, None)
    )
    saved = decode_document(encode_document(document))
    assert saved == document
    assert saved.words[0].letters == normalized[0].letters
    assert saved.words[0].end <= saved.words[1].start


@pytest.mark.parametrize("text", [("дом", "мой", "и"), ("дім", "мій", "і")])
def test_joint_repair_preserves_melisma_quiet_tail_and_fast_word_after_serialization(text):
    # The repair is supplied as a controlled input; pitch must neither choose the
    # lexical boundary nor change absolute melody time when that boundary moves.
    repaired = ordered(
        [
            AlignedWord(text[0], 1.0, 1.3, (1.0, 1.06, 1.22), 0.9),
            AlignedWord(text[1], 1.3, 1.56, (1.3, 1.32, 1.5), 0.9),
            AlignedWord(text[2], 1.56, 1.6, (1.56,), 0.9),
        ]
    )
    pitch = tuple(
        PitchPoint(
            index / 100,
            440.0 * 2 ** ((note - 69) / 12),
            0.51 if index >= 148 else 0.95,
            True,
        )
        for index in range(100, 160)
        for note in [57 if index < 120 else 60 if index < 150 else 64]
    )
    words = tuple(_word(item) for item in alignment_payload(repaired, {})["words"])
    document = construct_document(
        "t", "a", 2.0, " ".join(text), words, pitch, MusicMetadata(None, None)
    )
    whole = _word(alignment_payload([AlignedWord("а", 1.0, 1.6, (1.0,), 0.9)], {})["words"][0])
    reference = construct_document("t", "a", 2.0, "а", (whole,), pitch, MusicMetadata(None, None))
    saved = decode_document(encode_document(document))

    assert saved == document
    assert [(word.start, word.end) for word in saved.words] == [
        (1.0, 1.3),
        (1.3, 1.56),
        (1.56, 1.6),
    ]
    assert [(note.note, note.start, note.end) for word in saved.words for note in word.notes] == [
        (57, 1.0, 1.2),
        (60, 1.2, 1.3),
        (60, 1.3, 1.5),
        (64, 1.5, 1.56),
        (64, 1.56, 1.6),
    ]
    for step in (0.01, 0.005):
        assert list(saved.target_frames(step)) == list(reference.target_frames(step))
    for word, source in zip(saved.words, words, strict=True):
        assert word.letters == source.letters
        for note in word.notes:
            observed = [
                (note.start + fraction * (note.end - note.start), confidence)
                for fraction, _, confidence in note.contour
            ]
            expected = [
                (point.time, point.confidence)
                for point in pitch
                if note.start <= point.time < note.end
            ]
            assert observed == pytest.approx(expected)
