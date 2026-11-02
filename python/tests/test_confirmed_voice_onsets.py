from __future__ import annotations

import numpy as np
import pytest

from backend.ai_worker.ctc import AlignedWord, with_voice_onsets


def test_no_measured_onset_does_not_apply_a_fixed_shift() -> None:
    word = AlignedWord("і", 1.0, 1.04, (1.0,), 0.9)
    result = with_voice_onsets([word], np.empty(0), np.ones(200, dtype=bool))
    assert result[0].start == word.start
    assert result[0].end == word.end
    assert result[0].letters == word.letters
    assert "OnsetReviewRequired" in result[0].diagnostics


def test_a_measured_level_rise_calibrates_when_activity_has_no_pause() -> None:
    time = np.arange(3 * 16_000) / 16_000
    samples = (np.sin(2 * np.pi * 220 * time) * np.where(time < 1, 0.001, 0.2)).astype(np.float32)
    word = AlignedWord("так", 1.2, 1.8, (1.2, 1.4, 1.6), 0.9)
    result = with_voice_onsets([word], samples, np.ones(301, dtype=bool))
    assert result[0].start == pytest.approx(1.0, abs=0.02)
    assert result[0].end == word.end


def _activity(*intervals: tuple[float, float]) -> np.ndarray:
    frames = np.zeros(720, dtype=bool)
    for start, end in intervals:
        frames[round(start * 100) : round(end * 100)] = True
    return frames


def test_a_local_voice_entry_survives_a_shorter_ctc_pause() -> None:
    # The synthetic signal has two distinct entries. Only the first CTC start
    # is late; its 200-ms lag cannot override the second word's own entry.
    rate = 16_000
    times = np.arange(3 * rate) / rate
    active = ((times >= 1) & (times < 1.8)) | ((times >= 2) & (times < 2.5))
    samples = (0.2 * np.sin(2 * np.pi * 220 * times) * active).astype(np.float32)
    words = [
        AlignedWord("раз", 1.2, 1.9, (1.2, 1.4, 1.7), 0.8),
        AlignedWord("два", 2.0, 2.3, (2.0, 2.1, 2.2), 0.8),
    ]

    result = with_voice_onsets(words, samples)

    assert result[0].start == pytest.approx(1.0, abs=0.02)
    assert result[1] == words[1]


def test_a_louder_nasal_entry_cannot_erase_the_recognized_quiet_fricative() -> None:
    # Frozen GTSinger RU-Alto-1, Baikal Control0000 CTC core and local
    # activity: /s/ is audible before the loudness mask enters inside /m/.
    # Moving 5.56 to 5.64 also collapses the final consonant onto the word end.
    word = AlignedWord(
        "смотрят", 5.56, 6.36, (5.56, 5.72, 5.82, 5.92, 5.98, 6.08, 6.34), 0.2690175843
    )

    result = with_voice_onsets([word], np.empty(0), _activity((5.64, 7.02)))

    assert result == [word]
    assert result[0].letters[-1] < result[0].end


def test_a_recovered_acoustic_entry_does_not_inherit_an_unrelated_phrase_lag() -> None:
    # Baikal Breathy0000: the existing acoustic onset at 5.35 supplies a local
    # CTC candidate 5.38–6.16. This test protects that candidate, not its still
    # uncertain ending. No external reference time is given to the function.
    opening = AlignedWord("также", 0.48, 0.94, (0.48, 0.58, 0.72, 0.82, 0.92), 0.365108192)
    recovered = AlignedWord(
        "смотрят",
        5.38,
        6.16,
        (5.38, 5.58, 5.70, 5.78, 5.92, 6.0, 6.14),
        0.2751349583,
        ("OnsetRecovered",),
    )

    result = with_voice_onsets(
        [opening, recovered], np.empty(0), _activity((0.26, 4.46), (4.75, 6.93))
    )

    assert result[0].start == 0.26
    assert result[1] == recovered
