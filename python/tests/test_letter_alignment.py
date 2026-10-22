from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from backend.ai_worker.ctc import (
    AlignedWord,
    _evenly,
    _filled_letters,
    _placed,
    ordered,
    with_sung_ends,
    with_voice_onsets,
)
from backend.ai_worker.timing import voiced_frames
from backend.lyrics.codec import decode_document, encode_document
from backend.lyrics.domain import LyricsDocument, Word
from backend.moment_spreading import spread_tied_moments as _spread_tied_letters

_RATE = 16_000
_HOP = 160
_STEP = _HOP / _RATE


def _signal(bursts: list[tuple[float, float]], total: float) -> np.ndarray:
    samples = np.zeros(int(total * _RATE), dtype=np.float32)
    rng = np.random.default_rng(1)
    for start, end in bursts:
        first, last = int(start * _RATE), int(end * _RATE)
        samples[first:last] = 0.4 * rng.standard_normal(last - first).astype(np.float32)
    return samples


def test_voiced_frames_follow_the_sound_and_ignore_a_silent_intro() -> None:
    voiced = voiced_frames(_signal([(4.0, 6.0)], 8.0), _RATE, _HOP)

    assert not voiced[: int(3.9 / _STEP)].any()
    assert voiced[int(4.2 / _STEP) : int(5.8 / _STEP)].all()
    assert not voiced[int(6.3 / _STEP) :].any()


def test_voiced_frames_bridge_a_brief_dropout_between_continuous_sounds() -> None:
    voiced = voiced_frames(_signal([(1.0, 2.0), (2.08, 3.0)], 4.0), _RATE, _HOP)

    assert voiced[int(1.1 / _STEP) : int(2.9 / _STEP)].all()


def test_a_character_without_a_sound_starts_with_the_next_one() -> None:
    assert _filled_letters([1.0, None, 2.0, None], end=3.0) == (1.0, 2.0, 2.0, 3.0)


def test_a_fast_consonant_cluster_on_the_same_frame_is_spread_across_the_gap() -> None:
    # "м" and "у" both land on 4.43 (same model frame); the next distinct sounded character is at 4.63.
    spread = _spread_tied_letters([4.43, 4.43, 4.63], end=5.0)

    assert spread == pytest.approx([4.43, 4.53, 4.63])


def test_a_tied_run_at_the_end_of_a_word_spreads_to_the_word_end() -> None:
    spread = _spread_tied_letters([1.0, 2.0, 2.0, 2.0], end=2.6)

    assert spread == [1.0, 2.0, pytest.approx(2.2), pytest.approx(2.4)]


def test_a_near_tie_not_bit_identical_is_still_spread() -> None:
    # The alignment model is not bit-for-bit reproducible between process runs (CUDA algorithm
    # selection varies), so two characters that land on "the same" model frame do not always compare
    # exactly equal in floating point -- only close enough to round to the same displayed millisecond.
    spread = _spread_tied_letters([13.82, 13.820003, 13.851], end=15.99)
    first, second, third = spread
    assert first is not None and second is not None and third is not None

    assert first == pytest.approx(13.82)
    assert second > first
    assert second < third


def test_evenly_spreads_letters_when_a_window_is_too_short_for_its_word() -> None:
    # A single window word ("строкой", 7 characters) squeezed into a window barely wider than its own
    # character count in milliseconds would, purely evenly split, round several letters to the same
    # displayed millisecond even though the split is nominally even; spreading keeps them distinct
    # wherever there is enough room in the window to tell them apart at all.
    placed = _evenly(["строкой"], 10.0, 10.021)

    letters = placed[0].letters
    assert len(letters) == 7
    assert len(set(letters)) == len(letters), "every letter should get a distinct displayed moment"
    assert list(letters) == sorted(letters)


def test_letters_far_enough_apart_are_not_treated_as_tied() -> None:
    # A fast but genuine consonant transition (a few milliseconds) must not be flattened into a tie.
    letters: list[float | None] = [1.0, 1.006, 1.02]

    assert _spread_tied_letters(letters, end=2.0) == letters


def test_silent_characters_are_not_touched_by_spreading() -> None:
    # A tie at index 0-1 spreads; the None at index 2 is left for _filled_letters to assign later.
    spread = _spread_tied_letters([1.0, 1.0, None, 2.0], end=3.0)

    assert spread == [1.0, pytest.approx(1.5), None, 2.0]


def test_genuinely_distinct_letters_are_left_alone() -> None:
    assert _spread_tied_letters([1.0, 1.2, 1.5], end=2.0) == [1.0, 1.2, 1.5]


def test_a_word_with_nothing_to_pronounce_sits_between_its_neighbours() -> None:
    before = AlignedWord("а", 1.0, 2.0, (1.0,))
    after = AlignedWord("б", 3.0, 4.0, (3.0,))

    placed = _placed([before, None, after], ["а", "-", "б"])

    assert placed[1].text == "-"
    assert 2.0 <= placed[1].start <= placed[1].end <= 3.0 + 0.05


def test_a_held_vowel_stretches_its_word_to_the_end_of_the_sound() -> None:
    # "друг" is recognised at 1.0-1.3 s but the voice holds until 3.0 s; the next word starts at 3.5 s.
    words = [
        AlignedWord("друг", 1.0, 1.3, (1.0, 1.1, 1.2, 1.29)),
        AlignedWord("мой", 3.5, 3.8, (3.5, 3.6, 3.7)),
    ]

    stretched = with_sung_ends(words, _signal([(1.0, 3.0), (3.5, 3.9)], 5.0))

    assert stretched[0].end == pytest.approx(3.0, abs=0.1)
    assert stretched[0].letters == words[0].letters
    assert stretched[1].start == 3.5


def test_a_genuine_long_vowel_follows_audio_without_a_duration_ceiling() -> None:
    words = [AlignedWord("ah", 1.0, 1.3, (1.0, 1.2), 0.8)]

    stretched = with_sung_ends(words, _signal([(1.0, 12.0)], 13.0))

    assert stretched[0].end == pytest.approx(12.0, abs=0.05)
    assert stretched[0].letters == words[0].letters


def test_actual_final_word_releases_untranscribed_instrumental_outro() -> None:
    import torch
    from backend.ai_worker.ctc import align_words

    # Pinned 181–187-s excerpt: the user independently reports the final word finished by 183 s.
    # Cached MMS scores exercise the actual late-token error without downloading/running the model.
    with np.load(Path(__file__).with_name("fixtures") / "sadvit-outro.npz") as fixture:
        samples = fixture["vocal"].astype(np.float32)
        words = align_words(torch.from_numpy(fixture["scores"]), 0.02, ["навіки"])
        backing = fixture["instrumental"].astype(np.float32)
        timed = with_sung_ends(words, samples, instrumental=backing)

    assert words[0].end < 2.0, "raw CTC must leave the unmatched outro outside the final word"
    assert timed[0].end < 2.0, "refinement must not turn accompaniment bleed into a held vowel"
    assert timed[0].end > 1.2, "the actual phonetic tail continues beyond the last CTC spike"


@pytest.mark.parametrize("case_index", [0, 1])
def test_actual_phrase_end_does_not_follow_a_different_instrumental_source(case_index: int) -> None:
    import json

    # Independent acoustic checks distinguish the articulated vowel from the following
    # melody. Full-song MMS cores are pinned before refinement; no ASR endpoint is a cap.
    with np.load(Path(__file__).with_name("fixtures") / "sadvit-phrase-ends.npz") as fixture:
        case = json.loads(str(fixture["metadata"]))["cases"][case_index]
        offset, key = case["offset"], case["key"]
        source = case["word"]
        word = AlignedWord(
            source["text"], source["start"] - offset, source["end"] - offset,
            tuple(moment - offset for moment in source["letters"]), source["score"],
        )
        timed = with_sung_ends(
            [word], fixture["vocal" + key].astype(np.float32),
            instrumental=fixture["instrumental" + key].astype(np.float32),
        )[0]

    assert timed.end + offset >= case["independentVoiceCoreEnd"]
    assert timed.end + offset < case["beforeUnrelatedMelody"]
    assert timed.start == word.start


@pytest.mark.parametrize("quiet", [False, True])
def test_sung_extension_preserves_harmonic_melisma_over_backing(
    quiet: bool, monkeypatch: pytest.MonkeyPatch
) -> None:
    from backend.ai_worker import timing

    # A speech detector may reject an arbitrarily long steady/ornamented vowel. Its negative
    # decision is deliberately unhelpful: the independent source evidence must preserve singing.
    monkeypatch.setattr(
        timing, "get_vad_model",
        lambda: lambda samples: np.zeros((1, len(samples) // 512), dtype=np.float32),
    )
    time = np.arange(13 * _RATE) / _RATE
    active = (time >= 1.0) & (time < 12.0)
    # Changes of fundamental and vibrato are real continuation, even if a speech detector is unsure.
    phase = 2 * np.pi * np.cumsum(150 + 30 * np.sin(time * 2) + 3 * np.sin(time * 30)) / _RATE
    voice = sum(weight * np.sin(harmonic * phase) for harmonic, weight in [(1, .18), (2, .08), (3, .05)])
    backing = (0.2 * np.sin(2 * np.pi * 900 * time)).astype(np.float32)
    samples = (voice * active * (0.05 if quiet else 1.0) + backing * 0.03).astype(np.float32)
    words = [AlignedWord("ah", 1.0, 1.3, (1.0, 1.2), 0.8)]

    stretched = with_sung_ends(words, samples, instrumental=backing)

    assert stretched[0].end == pytest.approx(12.0, abs=0.15)


def test_quiet_independent_voice_survives_backing_dominated_spectral_power(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from backend.ai_worker import timing

    monkeypatch.setattr(
        timing, "get_vad_model",
        lambda: lambda samples: np.zeros((1, len(samples) // 512), dtype=np.float32),
    )
    time = np.arange(5 * _RATE) / _RATE
    phase = 2 * np.pi * np.cumsum(150 + 3 * np.sin(time * 30)) / _RATE
    voice = .002 * (np.sin(phase) + .4 * np.sin(phase * 2) + .2 * np.sin(phase * 3))
    backing = (0.3 * np.random.default_rng(42).standard_normal(len(time))).astype(np.float32)
    samples = (voice * ((time >= 1) & (time < 4)) + backing * .0001).astype(np.float32)
    words = [AlignedWord("ah", 1.0, 1.3, (1.0, 1.2), 0.8)]

    stretched = with_sung_ends(words, samples, instrumental=backing)

    assert stretched[0].end == pytest.approx(4.0, abs=0.15)


def test_a_word_never_stretches_into_the_next_one() -> None:
    words = [AlignedWord("а", 1.0, 1.2, (1.0,)), AlignedWord("б", 2.0, 2.2, (2.0,))]

    stretched = with_sung_ends(words, _signal([(1.0, 4.0)], 5.0))

    assert stretched[0].end <= 2.0


def test_letter_timings_survive_saving_and_are_validated() -> None:
    word = Word("друг", 1.0, 3.0, (), (1.0, 1.2, 1.4, 2.9))
    document = LyricsDocument("t", "a", 10.0, None, None, "друг", (word,))

    assert decode_document(encode_document(document)).words[0].letters == (1.0, 1.2, 1.4, 2.9)
    with pytest.raises(ValueError, match="every character"):
        Word("друг", 1.0, 3.0, (), (1.0, 1.2)).validate()
    with pytest.raises(ValueError, match="backwards"):
        Word("др", 1.0, 3.0, (), (2.0, 1.5)).validate()


def test_a_word_after_a_pause_starts_when_the_voice_starts() -> None:
    # The voice starts at 2.0 s and 4.0 s; the model marked the words 0.2 s late.
    words = [
        AlignedWord("раз", 2.2, 2.8, (2.2, 2.4, 2.6)),
        AlignedWord("два", 4.2, 4.8, (4.2, 4.4, 4.6)),
    ]

    moved = with_voice_onsets(words, _signal([(2.0, 2.9), (4.0, 4.9)], 6.0))

    assert moved[0].start == pytest.approx(2.0, abs=0.06)
    assert moved[1].start == pytest.approx(4.0, abs=0.06)
    assert moved[0].letters[0] == moved[0].start
    assert moved[0].end == 2.8


def test_the_typical_lag_is_removed_from_words_inside_a_phrase() -> None:
    words = [
        AlignedWord("раз", 2.2, 2.6, (2.2, 2.4, 2.5)),
        AlignedWord("два", 2.6, 3.0, (2.6, 2.8, 2.9)),
    ]

    moved = with_voice_onsets(words, _signal([(2.0, 3.1)], 5.0))

    assert moved[0].start == pytest.approx(2.0, abs=0.06)
    assert moved[1].start == pytest.approx(2.4, abs=0.06)
    assert moved[1].start >= moved[0].start


def test_text_is_split_into_stretches_pinned_to_where_whisper_heard_it() -> None:
    from backend.ai_worker.speech import _windows

    words = "раз два три четыре пять шесть семь восемь".split()
    heard = [
        ("раз", 10.0, 10.5),
        ("два", 10.5, 11.0),
        ("три", 11.0, 11.5),
        ("семь", 30.0, 30.5),
        ("восемь", 30.5, 31.0),
        ("х", 31.0, 31.2),
    ]

    windows = _windows(words, heard, total=60.0)

    pinned = [window for window in windows if window.last - window.first >= 3]
    assert (pinned[0].first, pinned[0].last) == (0, 3)
    assert pinned[0].start == pytest.approx(9.4) and pinned[0].end == pytest.approx(12.1)
    assert [(window.first, window.last) for window in windows][-1][1] == len(words)
    # Words nobody heard (четыре, пять, шесть) share the audio between the two heard stretches.
    gap = next(window for window in windows if window.first == 3)
    assert gap.start == pytest.approx(12.1) and gap.end >= 12.1


def test_without_any_recognised_run_the_whole_song_is_one_stretch() -> None:
    from backend.ai_worker.speech import _windows

    windows = _windows(["раз", "два", "три"], [("х", 1.0, 2.0)], total=30.0)

    assert [(window.first, window.last, window.start, window.end) for window in windows] == [
        (0, 3, 0.0, 30.0)
    ]


def test_heard_repeated_choruses_match_their_temporal_occurrence_when_one_is_missing() -> None:
    from backend.ai_worker.speech import _alignment_windows, _heard_positions

    words = "we will stay we will stay we will stay".split()
    whole = [
        AlignedWord(word, 1.0 + (index // 3) * 10 + index % 3, 1.5 + (index // 3) * 10 + index % 3, ())
        for index, word in enumerate(words)
    ]
    # ASR missed the first chorus; text alone would attach these to the first two repeats.
    heard = [(word.text, word.start, word.end) for word in whole[3:]]

    windows = _alignment_windows(" ".join(words), [], heard, whole, np.zeros(30 * _RATE))

    assert [(window.first, window.last) for window in windows] == [(0, 3), (3, 9)]
    assert windows[1].start == pytest.approx(10.4)
    assert _heard_positions(words, heard, whole) == {index: whole[index].start for index in range(3, 9)}


def test_words_from_overlapping_windows_end_up_ordered_and_with_positive_length() -> None:
    words = [
        AlignedWord("а", 5.0, 5.4, (5.0,)),
        AlignedWord(
            "б", 4.0, 4.5, (4.0,)
        ),  # a neighbouring window placed this word before the previous one
        AlignedWord("в", 6.0, 6.0, (6.0,)),
    ]

    fixed = ordered(words)

    assert [word.start for word in fixed] == sorted(word.start for word in fixed)
    assert all(word.end > word.start for word in fixed)
    assert all(word.start <= moment <= word.end for word in fixed for moment in word.letters)


def test_ordered_settles_an_overlap_without_moving_the_following_word() -> None:
    # End settlement must not overwrite the independent start of the following word.
    words = [
        AlignedWord("город", 7.62, 8.13, (7.62, 7.7, 7.8, 7.9, 8.0)),
        AlignedWord("магистрали", 8.1, 9.1, (8.1, 8.1, 8.2, 8.3)),
    ]

    fixed = ordered(words)

    assert fixed[0].end == pytest.approx(8.1)
    assert fixed[1].start == pytest.approx(8.1)
    assert fixed[1].letters[0] == pytest.approx(8.1)
    assert fixed[1].letters[1] > fixed[1].letters[0]


def test_ordered_preserves_long_unequal_letters_without_audio_evidence() -> None:
    # These are the existing suspicious "без" times, not independently verified boundaries.
    # Duration alone cannot justify replacing the model's evidence with an even split.
    words = [AlignedWord("без", 148.54, 160.14, (148.54, 148.732, 157.8))]

    fixed = ordered(words)

    assert fixed[0].end == words[0].end
    assert fixed[0].letters == words[0].letters


def test_an_erroneous_word_end_does_not_shift_the_rest_of_the_phrase() -> None:
    # A window supplies a bad end for one word, but subsequent word starts have their own evidence.
    # This scenario checks containment of that error; it does not assert true bounds for real "без".
    words = [
        AlignedWord("held", 1.0, 12.0, (1.0, 1.1, 1.2, 11.8)),
        AlignedWord("next", 2.0, 2.4, (2.0, 2.1, 2.2, 2.3)),
        AlignedWord("phrase", 2.5, 3.1, (2.5, 2.6, 2.7, 2.8, 2.9, 3.0)),
    ]

    fixed = ordered(words)

    assert [word.start for word in fixed[1:]] == [2.0, 2.5]
    assert [word.end for word in fixed[1:]] == [2.4, 3.1]
    assert fixed[0].end == 2.0
    assert all(letter <= fixed[0].end for letter in fixed[0].letters)


def test_ordered_preserves_independently_timed_words_shorter_than_fifty_ms() -> None:
    words = [
        AlignedWord("I", 1.0, 1.03, (1.0,)),
        AlignedWord("a", 1.03, 1.06, (1.03,)),
        AlignedWord("go", 1.06, 1.3, (1.06, 1.1)),
    ]

    fixed = ordered(words)

    assert [(word.start, word.end) for word in fixed] == [(1.0, 1.03), (1.03, 1.06), (1.06, 1.3)]


@pytest.mark.parametrize("transform", [ordered, with_sung_ends])
def test_boundary_refinement_retains_model_alignment_scores(transform) -> None:
    words = [AlignedWord("stay", 1.0, 2.0, (1.0, 1.1, 1.2, 1.3), 0.73)]
    arguments = [words] if transform is ordered else [words, _signal([(1.0, 2.0)], 3.0)]

    assert transform(*arguments)[0].score == 0.73


@pytest.mark.parametrize("score", [0.0, 0.73])
def test_speech_alignment_reports_supported_score_instead_of_perfect_confidence(
    monkeypatch: pytest.MonkeyPatch, score: float
) -> None:
    from backend.ai_worker import speech

    samples = _signal([(1.0, 2.0)], 3.0)
    words = [AlignedWord("stay", 1.0, 2.0, (1.0, 1.1, 1.2, 1.3), score)]
    monkeypatch.setattr(speech, "read_mono", lambda *_args: samples)
    monkeypatch.setattr(speech, "_alignment_evidence", lambda *_args: ("scores", 0.02, []))
    monkeypatch.setattr(speech, "align_words", lambda *_args: words)
    monkeypatch.setattr(speech, "align_guided", lambda *_args: words)

    result = speech.align(Path("vocal.wav"), "stay", "English")

    assert result["words"][0]["confidence"] == score


def test_speech_alignment_exposes_independent_boundary_conflicts_with_positive_scores(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from backend.ai_worker import speech

    samples = _signal([(1.0, 12.0)], 13.0)
    words = [AlignedWord("stay", 1.0, 11.0, (1.0, 1.1, 1.2, 10.9), 0.8)]
    monkeypatch.setattr(speech, "read_mono", lambda *_args: samples)
    monkeypatch.setattr(
        speech, "_alignment_evidence", lambda *_args: ("scores", 0.02, [("stay", 1.0, 2.0)])
    )
    monkeypatch.setattr(speech, "align_words", lambda *_args: words)
    monkeypatch.setattr(speech, "align_guided", lambda *_args: words)

    word = speech.align(Path("vocal.wav"), "stay", "English")["words"][0]

    assert word["confidence"] == 0.8
    assert word["diagnostics"] == ["AsrCtcBoundaryDisagreement"]
    assert word["end"] > 11.0, "diagnostic evidence must not silently cap the word at ASR's end"


def test_ordered_still_trusts_a_plausible_short_hold() -> None:
    # A genuine held note well under the per-character ceiling is left as the model actually heard it.
    words = [AlignedWord("тюрьма", 12.35, 13.37, (12.35, 12.374, 12.454, 12.534, 12.585, 12.635))]

    fixed = ordered(words)

    assert fixed[0].letters == pytest.approx((12.35, 12.374, 12.454, 12.534, 12.585, 12.635))


def test_ordered_never_leaves_two_words_overlapping() -> None:
    # "б" was placed by a neighbouring window before "а" ends; with_voice_onsets can also pull a start
    # earlier than the previous word's (already fixed) end. Either way, ordered() is the last safety net.
    words = [
        AlignedWord("а", 5.0, 5.4, (5.0,)),
        AlignedWord("б", 4.0, 4.5, (4.0,)),
        AlignedWord("в", 6.0, 6.0, (6.0,)),
    ]

    fixed = ordered(words)

    for earlier, later in zip(fixed, fixed[1:]):
        assert earlier.end <= later.start


def test_moving_a_start_back_never_puts_a_word_before_the_previous_one() -> None:
    # The second word ends before the first one starts: the correction must still keep them in order.
    words = [
        AlignedWord("раз", 4.0, 5.0, (4.0, 4.3, 4.6)),
        AlignedWord("два", 3.0, 3.5, (3.0, 3.2, 3.4)),
    ]

    moved = with_voice_onsets(words, _signal([(2.5, 5.2)], 7.0))

    assert moved[0].start <= moved[1].start
    assert all(word.end > word.start for word in moved)


def test_ctc_emission_and_whisper_guidance_run_concurrently(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import threading

    from backend.ai_worker import speech

    started: set[str] = set()
    lock = threading.Lock()
    both_started = threading.Event()

    def arrive(name: str) -> None:
        with lock:
            started.add(name)
            if len(started) == 2:
                both_started.set()
        assert both_started.wait(1), "alignment evidence still runs sequentially"

    def fake_emission(_samples):
        arrive("ctc")
        return "scores", 0.02

    def fake_transcribe(_vocal, _language, _prompt):
        arrive("whisper")
        return {"segments": []}

    monkeypatch.setenv("OMP_NUM_THREADS", "4")
    monkeypatch.setattr(speech, "emission", fake_emission)
    monkeypatch.setattr(speech, "_transcribe", fake_transcribe)

    scores, frame_seconds, heard = speech._alignment_evidence(
        Path("vocal.wav"), np.zeros(16, dtype=np.float32), "English", "lyrics"
    )

    assert (scores, frame_seconds, heard) == ("scores", 0.02, [])


@pytest.mark.parametrize("total", [60.317, 620.317])
def test_ctc_chunks_keep_one_fixed_frame_grid_through_the_end_of_long_audio(
    monkeypatch: pytest.MonkeyPatch, total: float
) -> None:
    import torch

    from backend.ai_worker import ctc

    # MMS's convolution stack has a 400-sample receptive field and a 320-sample stride.
    # Each fake logit records its source sample's absolute time, independent of chunk boundaries.
    class FixedStrideModel:
        def __call__(self, audio):
            count = (audio.shape[-1] - 400) // 320 + 1
            times = audio[:, : count * 320 : 320]
            return torch.stack((torch.zeros_like(times), times), dim=-1), None

    samples = np.arange(round(total * _RATE), dtype=np.float32) / (_RATE * 1000)
    monkeypatch.setattr(ctc, "_model", FixedStrideModel)
    monkeypatch.setattr(ctc, "device", lambda: "cpu")

    scores, frame_seconds = ctc.emission(samples)

    assert frame_seconds == 0.02
    assert len(scores) == (len(samples) - 400) // 320 + 1
    indices = torch.tensor([0, 999, 1000, 1999, 2000, len(scores) - 1])
    source_seconds = (scores[indices, 1] - scores[indices, 0]) * 1000
    assert source_seconds.tolist() == pytest.approx((indices * frame_seconds).tolist(), abs=0.001)


def test_local_mms_model_applies_the_bundles_required_waveform_normalization(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import torch

    from backend.ai_worker import ctc

    class CapturingModel(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.aux = torch.nn.Linear(2, 28)

        def forward(self, audio, lengths=None):
            return audio, lengths

    monkeypatch.setattr(ctc.torchaudio.models, "wav2vec2_model", lambda **_kwargs: CapturingModel())
    monkeypatch.setattr(ctc, "model_file", lambda _spec: Path("unused-model.bin"))
    monkeypatch.setattr(ctc, "device", lambda: "cpu")
    monkeypatch.setattr(
        ctc.torch, "load", lambda *_args, **_kwargs: {
            "aux.weight": torch.zeros(31, 2), "aux.bias": torch.zeros(31)
        }
    )
    samples = torch.tensor([[0.001, 0.002, -0.002, -0.001]])
    ctc._model.cache_clear()
    try:
        received, _ = ctc._model()(samples)
        assert received == pytest.approx(torch.nn.functional.layer_norm(samples, samples.shape))
    finally:
        ctc._model.cache_clear()


def test_alignment_guidance_uses_the_accelerated_cpu_backend_and_preserves_word_timestamps(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from types import SimpleNamespace

    from backend.ai_worker import speech

    model_root = tmp_path / "whisper-base"
    accelerated = model_root / "ctranslate2"
    accelerated.mkdir(parents=True)
    (model_root / "model.bin").write_bytes(b"openai weights")
    (accelerated / "model.bin").write_bytes(b"ctranslate2 weights")
    calls: dict[str, object] = {}

    class FakeModel:
        def __init__(self, path: str, **options: object) -> None:
            calls["load"] = (path, options)

        def transcribe(self, path: str, **options: object):
            calls["transcribe"] = (path, options)
            words = [SimpleNamespace(word=" hello", start=1.25, end=1.75)]
            return iter([SimpleNamespace(text=" hello", words=words)]), SimpleNamespace()

    monkeypatch.setattr(speech, "model_file", lambda _spec: model_root / "model.bin")
    monkeypatch.setattr(speech, "cpu_threads", lambda: 6)
    monkeypatch.setattr(speech, "WhisperModel", FakeModel)
    monkeypatch.setattr(speech, "read_mono", lambda *_: "mono samples")

    result = speech._accelerated_guidance(Path("voice.wav"), "English", "first line")

    assert calls["load"] == (
        str(accelerated),
        {"device": "cpu", "compute_type": "float32", "cpu_threads": 6, "num_workers": 1},
    )
    assert calls["transcribe"] == (
        "mono samples",
        {
            "language": "en",
            "word_timestamps": True,
            "initial_prompt": "first line",
            "condition_on_previous_text": False,
            "beam_size": 5,
        },
    )
    assert result == {
        "text": " hello",
        "segments": [{"text": " hello", "words": [{"word": " hello", "start": 1.25, "end": 1.75}]}],
    }


def test_catalog_line_timings_still_ask_whisper_which_phrase_a_word_belongs_to(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from backend.ai_worker import speech

    asked: list[str] = []
    monkeypatch.setattr(speech, "cpu_threads", lambda: 6)
    monkeypatch.setattr(speech.torch, "set_num_threads", lambda _threads: None)
    monkeypatch.setattr(speech, "emission", lambda _samples: ("scores", 0.02))

    def guidance(_vocal, _language, prompt, _threads=None):
        asked.append(prompt)
        return {"segments": [{"words": [{"word": "первая", "start": 10.6, "end": 11.0}]}]}

    monkeypatch.setattr(speech, "_guidance", guidance)

    result = speech._alignment_evidence(
        Path("voice.wav"), np.zeros(16, dtype=np.float32), "Russian", "первая строка"
    )

    assert result == ("scores", 0.02, [("первая", 10.6, 11.0)])
    assert asked == ["первая строка"]


def test_catalog_line_timings_become_alignment_windows() -> None:
    from backend.ai_worker.speech import _hint_windows

    windows = _hint_windows(
        "первая строка\nвторая строка",
        [
            {"start": 10.5, "text": "первая строка"},
            {"start": 14.0, "text": "вторая строка"},
        ],
        20.0,
    )

    assert [(item.first, item.last) for item in windows] == [(0, 2), (2, 4)]
    assert windows[0].start == pytest.approx(9.9)
    assert windows[0].end == pytest.approx(14.6)


def test_catalog_timing_tolerates_extra_words_in_the_preferred_plain_lyrics() -> None:
    from backend.ai_worker.speech import _hint_windows

    windows = _hint_windows(
        "вступление первая строка вторая строка финал",
        [
            {"start": 10.5, "text": "первая строка"},
            {"start": 14.0, "text": "вторая строка"},
        ],
        20.0,
    )

    assert windows
    assert windows[0].first == 0
    assert windows[-1].last == 6


def test_alignment_guidance_keeps_the_faster_native_whisper_path_on_cuda(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from backend.ai_worker import speech

    expected = {"segments": []}
    monkeypatch.setattr(speech, "device", lambda: "cuda")
    monkeypatch.setattr(
        speech,
        "_accelerated_guidance",
        lambda *_args, **_kwargs: pytest.fail("CPU accelerator must not replace CUDA Whisper"),
    )
    monkeypatch.setattr(speech, "_transcribe", lambda *_args: expected)

    assert speech._guidance(Path("voice.wav"), "English", None, 4) is expected


def test_coverage_transcription_uses_independent_full_text_even_with_cuda_alignment(monkeypatch):
    from backend.ai_worker import speech

    monkeypatch.setattr(speech, "device", lambda: "cuda")
    monkeypatch.setattr(speech, "_transcribe", lambda *_: {"text": "first verse"})
    monkeypatch.setattr(speech, "_accelerated_guidance", lambda *_: {"text": "first verse final chorus"})
    assert speech.transcribe(Path("voice.wav"), "English")["text"] == "first verse final chorus"


@pytest.mark.parametrize("threads", [4, 15])
def test_coverage_recognition_preserves_precision_and_uses_the_same_mono_decode(
    monkeypatch, tmp_path, threads,
):
    from types import SimpleNamespace
    from backend.ai_worker import speech

    (tmp_path / "model.bin").write_bytes(b"weights")
    (tmp_path / "ctranslate2").mkdir()
    (tmp_path / "ctranslate2/model.bin").write_bytes(b"weights")
    samples = np.zeros(16, dtype=np.float32)

    class Model:
        def __init__(self, _path, **options):
            assert options["compute_type"] == "float32"
            assert options["cpu_threads"] == threads

        def transcribe(self, audio, **options):
            assert audio is samples
            assert options["condition_on_previous_text"] is False
            return iter([SimpleNamespace(text=" first verse final chorus", words=[])]), None

    monkeypatch.setattr(speech, "model_file", lambda _: tmp_path / "model.bin")
    monkeypatch.setattr(speech, "cpu_threads", lambda: threads)
    monkeypatch.setattr(speech, "read_mono", lambda *_: samples)
    monkeypatch.setattr(speech, "WhisperModel", Model)
    assert speech.transcribe(Path("voice.wav"), "Ukrainian")["text"] == "first verse final chorus"


def test_phrase_guidance_separates_repeats_when_asr_merges_or_misspells_words():
    from backend.ai_worker.speech import _alignment_windows

    phrase = "Мы навстречу новым звёздам"
    lyrics = "\n".join([phrase, phrase, phrase])
    heard = [("мынавстречуновымзвездам", start, start + 3) for start in (10, 30, 50)]
    whole = [AlignedWord(word, 60 + i * 0.1, 60.1 + i * 0.1, ()) for i, word in enumerate(lyrics.split())]
    windows = _alignment_windows(lyrics, (), heard, whole, np.zeros(70 * _RATE, dtype=np.float32))
    assert [(window.first, window.last) for window in windows] == [(0, 4), (4, 8), (8, 12)]
    assert [window.start for window in windows] == pytest.approx([9.4, 29.4, 49.4])
    assert [window.end for window in windows] == pytest.approx([13.6, 33.6, 53.6])


def test_fuzzy_phrase_start_reaches_alignment_choice_as_independent_evidence(monkeypatch):
    from backend.ai_worker import speech

    lyrics = "Мы навстречу новым звёздам\nМы навстречу новым звёздам"
    whole = [AlignedWord(word, 30+i, 30.5+i, (), 0.9) for i, word in enumerate(lyrics.split())]
    heard = [("мынавстречуновымзвездам", start, start+3) for start in (10, 20)]
    monkeypatch.setattr(speech, "read_mono", lambda *_: np.zeros(40*_RATE))
    monkeypatch.setattr(speech, "_alignment_evidence", lambda *_: (None, 0.02, heard))
    monkeypatch.setattr(speech, "align_words", lambda *_: whole)
    captured = {}

    def align_guided(*args):
        captured.update(args[4])
        return whole

    monkeypatch.setattr(speech, "align_guided", align_guided)
    monkeypatch.setattr(speech, "with_sung_ends", lambda words, *_: words)
    monkeypatch.setattr(speech, "with_voice_onsets", lambda words, *_: words)
    speech.align(Path("voice.wav"), lyrics, "Russian")
    assert captured.get(0) == pytest.approx(10)
    assert captured.get(4) == pytest.approx(20)


def test_phrase_matching_does_not_take_a_shared_suffix_from_a_different_line():
    from backend.ai_worker.speech import _phrase_windows

    lyrics = "quiet we will stay\nwe will stay\nagain we will stay"
    heard = [("wewillstay", 10.0, 13.0), ("againwewillstay", 20.0, 24.0)]
    starts = [5, 6, 7, 8, 30, 31, 32, 40, 41, 42, 43]
    whole = [AlignedWord(word, start, start+0.4, ()) for word, start in zip(lyrics.split(), starts)]
    windows = _phrase_windows(lyrics, heard, 45, whole)
    assert any(w.first == 4 and w.heard_start == 10 for w in windows)
    assert any(w.first == 7 and w.heard_start == 20 for w in windows)


def _phrases(phrases: list[tuple[float, float]], total: float) -> np.ndarray:
    """Sung phrases as steady tones (one level throughout) separated by silence."""
    samples = np.zeros(int(total * _RATE), dtype=np.float32)
    for start, end in phrases:
        first, last = int(start * _RATE), int(end * _RATE)
        time = np.arange(last - first) / _RATE
        samples[first:last] = 0.4 * np.sin(2 * np.pi * 220.0 * time).astype(np.float32)
    return samples


def test_a_voice_entering_after_silence_is_an_onset_but_a_held_tone_is_not() -> None:
    from backend.ai_worker.timing import vocal_onsets

    onsets = vocal_onsets(_phrases([(1.0, 2.5), (3.0, 4.0)], 5.0), _RATE, _HOP)

    assert onsets == pytest.approx([1.0, 3.0], abs=0.03)


def test_a_word_stops_lighting_once_the_voice_has_paused() -> None:
    # The model kept "take" sounding from 1.0 s right through a 1.4 s pause until the next word at 3.0 s.
    words = [
        AlignedWord("take", 1.0, 3.0, (1.0, 1.1, 1.2, 2.8)),
        AlignedWord("these", 3.0, 3.5, (3.0, 3.1, 3.2, 3.3, 3.4)),
    ]

    trimmed = with_sung_ends(words, _signal([(1.0, 1.6), (3.0, 3.6)], 5.0))

    assert trimmed[0].end == pytest.approx(1.6, abs=0.05)
    assert all(letter <= trimmed[0].end for letter in trimmed[0].letters)


def test_a_short_breath_inside_a_word_does_not_end_it() -> None:
    words = [AlignedWord("stay", 1.0, 2.0, (1.0, 1.1, 1.2, 1.3))]

    kept = with_sung_ends(words, _signal([(1.0, 1.4), (1.6, 2.0)], 3.0))

    assert kept[0].end == pytest.approx(2.0, abs=0.05)


def test_catalog_lines_open_where_the_voice_enters_and_never_reach_into_the_next_line() -> None:
    from backend.ai_worker.speech import _hint_windows

    windows = _hint_windows(
        "please stay i want you",
        [{"start": 10.0, "text": "please stay"}, {"start": 14.0, "text": "i want you"}],
        20.0,
        np.array([10.2, 14.1]),
    )

    assert [(item.first, item.last) for item in windows] == [(0, 2), (2, 5)]
    assert windows[0].start == pytest.approx(10.15)
    assert windows[0].end == pytest.approx(14.05)
    assert windows[1].start == pytest.approx(14.05)


def test_a_catalog_timing_made_for_another_release_is_moved_onto_this_recording() -> None:
    from backend.ai_worker.speech import _shifted_hints

    words = "a b c d e f g h i j".split()
    hints = [{"start": float(index * 4), "text": word} for index, word in enumerate(words)]
    whole = [AlignedWord(word, index * 4 + 2.5, index * 4 + 3.0, ()) for index, word in enumerate(words)]

    shifted = _shifted_hints(words, hints, whole)

    assert [item["start"] for item in shifted] == pytest.approx([index * 4 + 2.5 for index in range(10)])


def test_catalog_timings_that_already_fit_are_left_alone() -> None:
    from backend.ai_worker.speech import _shifted_hints

    words = "a b c d e f".split()
    hints = [{"start": float(index * 4), "text": word} for index, word in enumerate(words)]
    whole = [AlignedWord(word, index * 4 + 0.1, index * 4 + 0.5, ()) for index, word in enumerate(words)]

    assert [item["start"] for item in _shifted_hints(words, hints, whole)] == [
        index * 4.0 for index in range(6)
    ]


def test_whisper_settles_which_phrase_a_word_belongs_to_when_the_model_is_unsure() -> None:
    from backend.ai_worker.ctc import _preferred

    # The model is more confident in "stay" on the next phrase, but Whisper heard it on the first one.
    guided = [AlignedWord("please", 1.0, 2.2, (1.0,), 0.06), AlignedWord("stay", 2.5, 3.5, (2.5,), 0.06)]
    whole = [AlignedWord("please", 1.0, 3.5, (1.0,), 0.13), AlignedWord("stay", 4.9, 5.1, (4.9,), 0.13)]
    voiced = voiced_frames(_signal([(1.0, 2.2), (2.5, 3.5), (4.9, 5.4)], 6.0), _RATE, _HOP)

    chosen = _preferred(guided, whole, 0, {0: 1.2, 1: 2.6}, voiced)

    assert [word.start for word in chosen] == [1.0, 2.5]


def test_whisper_is_not_followed_into_silence() -> None:
    from backend.ai_worker.ctc import _preferred

    # Whisper's (wrong) times favour the placement that starts "stay" where nothing is sung.
    guided = [AlignedWord("please", 1.0, 2.2, (1.0,), 0.06), AlignedWord("stay", 3.8, 4.0, (3.8,), 0.06)]
    whole = [AlignedWord("please", 1.0, 2.2, (1.0,), 0.13), AlignedWord("stay", 2.5, 3.5, (2.5,), 0.13)]
    voiced = voiced_frames(_signal([(1.0, 2.2), (2.5, 3.5)], 6.0), _RATE, _HOP)

    chosen = _preferred(guided, whole, 0, {0: 1.0, 1: 3.9}, voiced)

    assert [word.start for word in chosen] == [1.0, 2.5]
