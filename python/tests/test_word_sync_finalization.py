from __future__ import annotations

import pytest

from backend.ai.domain import PitchPoint
from backend.ai_worker.ctc import AlignedWord, ordered
from backend.ai_worker.recognition import alignment_payload, rate_review_indices
from backend.infrastructure.command_ai_provider import _word
from backend.lyrics.codec import decode_document, encode_document
from backend.processing.algorithms import MusicMetadata, construct_document
from backend.processing.reporting import alignment_warnings


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
