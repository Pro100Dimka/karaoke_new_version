from __future__ import annotations

import numpy as np
import pytest

from backend.ai_worker.ctc import AlignedWord, ordered, with_sung_ends, with_voice_onsets
from backend.ai_worker.recognition import alignment_payload

RATE = 16_000


def _voice(parts: list[tuple[float, float, float]], duration: float = 3.0) -> np.ndarray:
    time = np.arange(round(duration * RATE)) / RATE
    phase = 2 * np.pi * (180 * time + 0.1 * np.sin(2 * np.pi * 5 * time))
    voice = np.sin(phase) + 0.4 * np.sin(2 * phase) + 0.2 * np.sin(3 * phase)
    envelope = sum(level * ((time >= first) & (time < last)) for first, last, level in parts)
    return (voice * envelope).astype(np.float32)


@pytest.mark.parametrize("text", ["и", "і"])
def test_sung_end_does_not_invent_fifty_ms_for_a_genuine_fast_word(text: str) -> None:
    word = AlignedWord(text, 1.0, 1.03, (1.0,), 0.8)
    result = with_sung_ends([word], _voice([(1.0, 1.03, 0.2)]))
    assert result[0].start == word.start
    assert result[0].end == word.end


@pytest.mark.parametrize("text", ["и", "і"])
def test_onset_refinement_keeps_the_actual_start_of_a_fast_word(text: str) -> None:
    words = [
        AlignedWord("а", 0.5, 0.8, (0.5,), 0.9),
        AlignedWord(text, 1.0, 1.03, (1.0,), 0.8),
    ]
    result = with_voice_onsets(words, _voice([(0.5, 0.8, 0.2), (1.0, 1.03, 0.2)]))
    assert result[1].start == words[1].start
    assert result[1].end == words[1].end


def test_ordering_cannot_hide_a_destroyed_phonetic_core() -> None:
    words = [
        AlignedWord("дом", 1.0, 2.0, (1.0, 1.08, 1.9), 0.8),
        AlignedWord("мой", 1.1, 2.5, (1.1, 2.1, 2.4), 0.3),
    ]
    result = ordered(words)
    assert result[0].end <= result[1].start
    assert "BoundaryConflict" in result[0].diagnostics
    assert "BoundaryConflict" in alignment_payload(result, {})["words"][0]["diagnostics"]
    # A second normalization cannot erase the evidence needed by local review.
    assert ordered(result)[0].diagnostics == result[0].diagnostics


def test_normal_boundary_rounding_does_not_request_an_acoustic_repair() -> None:
    words = [
        AlignedWord("дом", 1.0, 2.0, (1.0, 1.1, 1.9), 0.8),
        AlignedWord("мой", 1.99, 2.5, (1.99, 2.1, 2.4), 0.8),
    ]
    assert all(not word.diagnostics for word in ordered(words))


@pytest.mark.parametrize("text", ["мой", "мій"])
def test_quiet_sustained_tail_stops_at_silence_before_a_delayed_echo(text: str) -> None:
    samples = _voice([(1.0, 1.3, 0.2), (1.3, 2.0, 0.02), (2.45, 2.7, 0.04)])
    result = with_sung_ends([AlignedWord(text, 1.0, 1.3, (1.0, 1.1, 1.2), 0.8)], samples)
    assert result[0].end == pytest.approx(2.0, abs=0.03)
    assert result[0].end < 2.45
