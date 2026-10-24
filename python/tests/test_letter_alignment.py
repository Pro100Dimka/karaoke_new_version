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


def test_repeated_outro_uses_joint_recognition_instead_of_compressing_late_replies() -> None:
    from backend.ai_worker.ctc import Window
    from backend.ai_worker.recognition import contextual_guidance

    words = ["дозволиш", "мені"] * 4
    windows = [
        Window(i * 2, i * 2 + 2, start, end, start + 0.6)
        for i, (start, end) in enumerate(
            [(228, 231.68), (232.14, 235.24), (234.04, 237), (235.8, 238.8)]
        )
    ]
    whole = [
        AlignedWord(word, 243 + i * 0.3, 243.2 + i * 0.3, (), 0.02) for i, word in enumerate(words)
    ]
    timings = {1: (230.52, 231.08), 3: (234.08, 234.64), 5: (235.86, 236.4), 7: (237.66, 238.2)}
    # Native Whisper on the actual Motor'rolla outro, independently decoded with neighbouring lyrics.
    spans = [
        (229.98, 231.38),
        (231.38, 232.78),
        (232.78, 233.98),
        (233.98, 235),
        (236.4, 237.54),
        (237.54, 238.22),
        (239.78, 241.18),
        (241.18, 241.94),
    ]
    result = {
        "segments": [
            {
                "words": [
                    {"word": word, "start": a, "end": b}
                    for word, (a, b) in zip(words, spans, strict=True)
                ]
            }
        ]
    }
    activity = np.zeros(25000, dtype=bool)
    activity[22900:24260] = True
    revised, supported = contextual_guidance(
        words,
        windows,
        whole,
        timings,
        activity,
        lambda contexts: {"contexts": [result for _ in contexts]},
    )
    assert supported[6] == pytest.approx(spans[6])
    assert supported[7] == pytest.approx(spans[7])
    assert revised[-1].heard_start == pytest.approx(239.78)


def test_partial_catalog_hints_leave_audio_for_unhinted_choruses_and_the_final_phrase():
    from backend.ai_worker.speech import _alignment_windows

    lyrics = "we wait\nsing with me\nwe wait\nsing with me"
    starts = [1.0, 2.0, 4.0, 5.0, 6.0, 10.0, 11.0, 14.0, 15.0, 16.0]
    whole = [
        AlignedWord(text, start, start + 0.4, (), 0.5)
        for text, start in zip(lyrics.split(), starts, strict=True)
    ]
    windows = _alignment_windows(
        lyrics,
        [{"start": 1.0, "text": "we wait"}, {"start": 10.0, "text": "we wait"}],
        [],
        whole,
        np.zeros(20 * _RATE, dtype=np.float32),
    )

    for first, last in [(2, 5), (7, 10)]:
        assert any(
            window.first <= first
            and window.last >= last
            and window.start <= starts[first] < window.end
            for window in windows
        ), "lyrics between catalogue entries must not be forced into an empty audio window"


def test_default_recognizer_recovers_all_performed_choruses_from_a_fresh_import(
    monkeypatch,
    tmp_path,
):
    import json
    import threading
    from copy import deepcopy
    from types import SimpleNamespace
    from backend.ai_worker import speech
    from backend.lyrics.discovery import _complete_repeats

    with np.load(Path(__file__).with_name("fixtures") / "chorus-entry.npz") as fixture:
        case = json.loads(str(fixture["recognition_metadata"]))
    for name in ("whisper-base", "whisper-large-v3-turbo"):
        target = tmp_path / name / "ctranslate2"
        target.mkdir(parents=True)
        (target / "model.bin").write_bytes(b"test model")

    class RecordedModel:
        def __init__(self, path, **_options):
            self.result = case["strong" if "large-v3-turbo" in path else "weak"]

        def transcribe(self, *_args, **_options):
            segments = [
                SimpleNamespace(
                    text=s["text"],
                    words=[SimpleNamespace(**w) for w in s["words"]],
                )
                for s in self.result["segments"]
            ]
            return iter(segments), SimpleNamespace()

    monkeypatch.setattr(speech, "model_file", lambda spec: tmp_path / spec.model_id / "model.bin")
    monkeypatch.setattr(speech, "WhisperModel", RecordedModel, raising=False)
    monkeypatch.setattr(
        speech.whisper,
        "load_model",
        lambda path, **_: SimpleNamespace(
            set_alignment_heads=lambda *_: None,
            transcribe=lambda *_a, **_kw: deepcopy(
                case["strong" if "large-v3-turbo" in str(path) else "weak"]
            ),
        ),
    )
    monkeypatch.setattr(speech, "read_mono", lambda *_: "recorded audio")

    transcript = speech.transcribe(Path("vocal.wav"), "Ukrainian")["text"]
    recovered = _complete_repeats(case["catalog"], transcript, threading.Event())

    assert recovered.splitlines() == case["expected"]


def test_real_chorus_entry_can_move_past_an_unrecognized_misplaced_neighbour():
    import json
    import torch
    from backend.ai_worker.ctc import Window
    from backend.ai_worker.word_guidance import with_word_guidance

    with np.load(Path(__file__).with_name("fixtures") / "chorus-entry.npz") as fixture:
        case = json.loads(str(fixture["entry_metadata"]))
        scores = torch.from_numpy(fixture["entry_scores"])
        vocal = fixture["entry_vocal"].astype(np.float32)
    words = [AlignedWord(**w) for w in case["words"]]
    voiced = voiced_frames(vocal, _RATE, _HOP)

    placed = with_word_guidance(
        words,
        scores,
        0.02,
        [Window(**case["window"])],
        {int(i): tuple(times) for i, times in case["timings"].items()},
        voiced,
        0.6,
        recognized=case["heard"],
    )

    # Original mix and independent vocal recognition put the entry at ~42 s and
    # the following phrase at ~46 s. The fixture's audio begins at 37 s.
    assert 4.5 < placed[0].start < 6.0
    assert 8.8 < placed[5].start < 10.0


def test_accelerator_preparation_bootstraps_the_verified_native_checkpoint(monkeypatch, tmp_path):
    from backend.ai_worker import speech

    root = tmp_path / "speech"
    downloaded = []

    def download_native(url, target, in_memory):
        path = Path(target) / "checkpoint.pt"
        path.write_bytes(b"verified by Whisper downloader")
        return str(path)

    monkeypatch.setattr(speech, "model_directory", lambda _: root)
    monkeypatch.setattr(speech.whisper, "_download", download_native)
    monkeypatch.setattr(
        speech, "download_model", lambda name, **_: downloaded.append(name), raising=False
    )

    speech.prepare_accelerator()

    assert (root / "model.bin").read_bytes() == b"verified by Whisper downloader"
    assert downloaded == []


def test_alignment_uses_the_more_complete_independent_audio_view(monkeypatch):
    import json
    import torch
    from backend.ai_worker import speech

    with np.load(Path(__file__).with_name("fixtures") / "chorus-entry.npz") as fixture:
        case = json.loads(str(fixture["recognition_metadata"]))
    calls = []

    def recognize(audio, *_args, **_kwargs):
        calls.append(audio)
        return case["mixed" if isinstance(audio, np.ndarray) else "partial"]

    monkeypatch.setattr(speech, "_guidance", recognize)
    monkeypatch.setattr(speech, "emission", lambda *_: (torch.zeros(1, 28), 0.02))
    monkeypatch.setattr(speech.torch, "set_num_threads", lambda _: None)

    _, _, heard = speech._alignment_evidence(
        Path("vocals.wav"),
        np.ones(160),
        "Ukrainian",
        "\n".join(case["expected"]),
        np.ones(160),
    )

    assert heard == speech._heard_words(case["mixed"])
    assert len(calls) == 2
    np.testing.assert_array_equal(calls[1], np.full(160, 2.0))


@pytest.mark.parametrize("target", ["cpu", "cuda"])
def test_verified_local_checkpoint_restores_official_word_alignment_heads(monkeypatch, target):
    from backend.ai_worker import speech

    selected = []
    expected = speech.whisper._ALIGNMENT_HEADS[
        speech.SPEECH_MODEL.model_id.removeprefix("whisper-")
    ]

    class NativeModel:
        def set_alignment_heads(self, heads):
            selected.append(heads)

        def transcribe(self, *_args, **_kwargs):
            assert selected == [expected], "local weights need the named model's timing metadata"
            return {"text": "recognized", "segments": []}

    monkeypatch.setattr(speech, "device", lambda: target)
    monkeypatch.setattr(speech, "model_file", lambda _: Path("verified-model.bin"))
    monkeypatch.setattr(speech.whisper, "load_model", lambda *_a, **_kw: NativeModel())

    assert speech._transcribe(Path("voice.wav"), "Ukrainian", None)["text"] == "recognized"


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
            source["text"],
            source["start"] - offset,
            source["end"] - offset,
            tuple(moment - offset for moment in source["letters"]),
            source["score"],
        )
        timed = with_sung_ends(
            [word],
            fixture["vocal" + key].astype(np.float32),
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
        timing,
        "get_vad_model",
        lambda: lambda samples: np.zeros((1, len(samples) // 512), dtype=np.float32),
    )
    time = np.arange(13 * _RATE) / _RATE
    active = (time >= 1.0) & (time < 12.0)
    # Changes of fundamental and vibrato are real continuation, even if a speech detector is unsure.
    phase = 2 * np.pi * np.cumsum(150 + 30 * np.sin(time * 2) + 3 * np.sin(time * 30)) / _RATE
    voice = sum(
        weight * np.sin(harmonic * phase) for harmonic, weight in [(1, 0.18), (2, 0.08), (3, 0.05)]
    )
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
        timing,
        "get_vad_model",
        lambda: lambda samples: np.zeros((1, len(samples) // 512), dtype=np.float32),
    )
    time = np.arange(5 * _RATE) / _RATE
    phase = 2 * np.pi * np.cumsum(150 + 3 * np.sin(time * 30)) / _RATE
    voice = 0.002 * (np.sin(phase) + 0.4 * np.sin(phase * 2) + 0.2 * np.sin(phase * 3))
    backing = (0.3 * np.random.default_rng(42).standard_normal(len(time))).astype(np.float32)
    samples = (voice * ((time >= 1) & (time < 4)) + backing * 0.0001).astype(np.float32)
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
        AlignedWord(
            word, 1.0 + (index // 3) * 10 + index % 3, 1.5 + (index // 3) * 10 + index % 3, ()
        )
        for index, word in enumerate(words)
    ]
    # ASR missed the first chorus; text alone would attach these to the first two repeats.
    heard = [(word.text, word.start, word.end) for word in whole[3:]]

    windows = _alignment_windows(" ".join(words), [], heard, whole, np.zeros(30 * _RATE))

    assert [(window.first, window.last) for window in windows] == [(0, 3), (3, 9)]
    assert windows[1].start == pytest.approx(10.4)
    assert _heard_positions(words, heard, whole) == {
        index: whole[index].start for index in range(3, 9)
    }


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


def test_native_recognition_finishes_before_ctc_to_bound_model_memory(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from backend.ai_worker import speech

    completed = []

    def fake_emission(_samples):
        assert completed == ["whisper"]
        completed.append("ctc")
        return "scores", 0.02

    def fake_transcribe(_vocal, _language, _prompt):
        completed.append("whisper")
        return {"segments": []}

    monkeypatch.setenv("OMP_NUM_THREADS", "4")
    monkeypatch.setattr(speech, "emission", fake_emission)
    monkeypatch.setattr(speech, "_transcribe", fake_transcribe)
    monkeypatch.setattr(speech, "_guidance", lambda *_a, **_kw: fake_transcribe(None, None, None))

    scores, frame_seconds, heard = speech._alignment_evidence(
        Path("vocal.wav"), np.zeros(16, dtype=np.float32), "English", "lyrics"
    )

    assert (scores, frame_seconds, heard) == ("scores", 0.02, [])
    assert completed == ["whisper", "ctc"]


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
        ctc.torch,
        "load",
        lambda *_args, **_kwargs: {"aux.weight": torch.zeros(31, 2), "aux.bias": torch.zeros(31)},
    )
    samples = torch.tensor([[0.001, 0.002, -0.002, -0.001]])
    ctc._model.cache_clear()
    try:
        received, _ = ctc._model()(samples)
        assert received == pytest.approx(torch.nn.functional.layer_norm(samples, samples.shape))
    finally:
        ctc._model.cache_clear()


def test_alignment_guidance_uses_native_cpu_precision_and_preserves_word_timestamps(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
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

        def set_alignment_heads(self, heads):
            calls["heads"] = heads

        def transcribe(self, path: str, **options: object):
            calls["transcribe"] = (path, options)
            return {
                "text": " hello",
                "segments": [
                    {
                        "start": 1.25,
                        "end": 1.75,
                        "words": [{"word": " hello", "start": 1.25, "end": 1.75}],
                    }
                ],
            }

    monkeypatch.setattr(speech, "model_file", lambda _spec: model_root / "model.bin")
    monkeypatch.setattr(speech, "cpu_threads", lambda: 6)
    monkeypatch.setattr(speech, "device", lambda: "cpu")
    monkeypatch.setattr(speech.torch, "set_num_threads", lambda _: None)
    monkeypatch.setattr(speech.whisper, "load_model", FakeModel)
    monkeypatch.setattr(speech, "read_mono", lambda *_: "mono samples")

    result = speech._accelerated_guidance(Path("voice.wav"), "English", "first line")

    assert calls["load"] == (
        str(model_root / "model.bin"),
        {"device": "cpu"},
    )
    assert calls["transcribe"] == (
        "mono samples",
        {
            "language": "en",
            "word_timestamps": True,
            "initial_prompt": "first line",
            "condition_on_previous_text": False,
            "fp16": False,
            "temperature": 0.0,
        },
    )
    assert result == {
        "text": " hello",
        "segments": [
            {"start": 1.25, "end": 1.75, "words": [{"word": " hello", "start": 1.25, "end": 1.75}]}
        ],
    }


def test_native_alignment_recognition_disables_sampling_fallback(monkeypatch):
    from backend.ai_worker import speech
    from types import SimpleNamespace

    calls = {}
    model = SimpleNamespace(
        transcribe=lambda path, **options: calls.update(options) or {},
        set_alignment_heads=lambda *_: None,
    )
    monkeypatch.setattr(speech, "device", lambda: "cuda")
    monkeypatch.setattr(speech, "model_file", lambda _: Path("speech.pt"))
    monkeypatch.setattr(speech.whisper, "load_model", lambda *args, **kwargs: model)

    speech._transcribe(Path("voice.wav"), "Russian", "lyrics")

    assert calls.get("temperature") == 0.0


def test_catalog_line_timings_still_ask_whisper_which_phrase_a_word_belongs_to(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from backend.ai_worker import speech

    asked: list[str] = []
    monkeypatch.setattr(speech, "cpu_threads", lambda: 6)
    monkeypatch.setattr(speech.torch, "set_num_threads", lambda _threads: None)
    monkeypatch.setattr(speech, "emission", lambda _samples: ("scores", 0.02))

    def guidance(_vocal, _language, prompt, _threads=None, **_options):
        asked.append(prompt)
        return {"segments": [{"words": [{"word": "первая", "start": 10.6, "end": 11.0}]}]}

    monkeypatch.setattr(speech, "_guidance", guidance)

    result = speech._alignment_evidence(
        Path("voice.wav"), np.zeros(16, dtype=np.float32), "Russian", "первая строка"
    )

    assert result == ("scores", 0.02, [("первая", 10.6, 11.0)])
    assert asked == [None], "the complete catalogue must not be decoded as an audio prompt"


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
    monkeypatch.setattr(
        speech, "_accelerated_guidance", lambda *_: {"text": "first verse final chorus"}
    )
    assert speech.transcribe(Path("voice.wav"), "English")["text"] == "first verse final chorus"


@pytest.mark.parametrize("threads", [4, 15])
def test_coverage_recognition_preserves_precision_and_uses_the_same_mono_decode(
    monkeypatch,
    tmp_path,
    threads,
):
    from backend.ai_worker import speech

    (tmp_path / "model.bin").write_bytes(b"weights")
    (tmp_path / "ctranslate2").mkdir()
    (tmp_path / "ctranslate2/model.bin").write_bytes(b"weights")
    samples = np.zeros(16, dtype=np.float32)
    selected_threads = []

    class Model:
        def __init__(self, _path, **options):
            assert options["device"] == "cpu"

        def set_alignment_heads(self, _heads):
            pass

        def transcribe(self, audio, **options):
            assert audio is samples
            assert options["condition_on_previous_text"] is False
            assert options["fp16"] is False
            return {"text": " first verse final chorus", "segments": []}

    monkeypatch.setattr(speech, "model_file", lambda _: tmp_path / "model.bin")
    monkeypatch.setattr(speech, "cpu_threads", lambda: threads)
    monkeypatch.setattr(speech, "read_mono", lambda *_: samples)
    monkeypatch.setattr(speech, "device", lambda: "cpu")
    monkeypatch.setattr(speech.torch, "set_num_threads", selected_threads.append)
    monkeypatch.setattr(speech.whisper, "load_model", Model)
    assert speech.transcribe(Path("voice.wav"), "Ukrainian")["text"] == "first verse final chorus"
    assert selected_threads == [threads]


def test_phrase_guidance_separates_repeats_when_asr_merges_or_misspells_words():
    from backend.ai_worker.speech import _alignment_windows

    phrase = "Мы навстречу новым звёздам"
    lyrics = "\n".join([phrase, phrase, phrase])
    heard = [("мынавстречуновымзвездам", start, start + 3) for start in (10, 30, 50)]
    whole = [
        AlignedWord(word, 60 + i * 0.1, 60.1 + i * 0.1, ()) for i, word in enumerate(lyrics.split())
    ]
    windows = _alignment_windows(lyrics, (), heard, whole, np.zeros(70 * _RATE, dtype=np.float32))
    assert [(window.first, window.last) for window in windows] == [(0, 4), (4, 8), (8, 12)]
    assert [window.start for window in windows] == pytest.approx([9.4, 29.4, 49.4])
    assert [window.end for window in windows] == pytest.approx([13.6, 33.6, 53.6])


def test_fuzzy_phrase_start_reaches_alignment_choice_as_independent_evidence(monkeypatch):
    from backend.ai_worker import speech

    lyrics = "Мы навстречу новым звёздам\nМы навстречу новым звёздам"
    whole = [AlignedWord(word, 30 + i, 30.5 + i, (), 0.9) for i, word in enumerate(lyrics.split())]
    heard = [("мынавстречуновымзвездам", start, start + 3) for start in (10, 20)]
    monkeypatch.setattr(speech, "read_mono", lambda *_: np.zeros(40 * _RATE))
    monkeypatch.setattr(speech, "_alignment_evidence", lambda *_: (None, 0.02, heard))
    monkeypatch.setattr(speech, "align_words", lambda *_: whole)
    captured = {}

    def align_guided(*args):
        captured.update(args[4])
        return whole

    monkeypatch.setattr(speech, "align_guided", align_guided)
    monkeypatch.setattr(speech, "with_word_guidance", lambda words, *args, **kwargs: words)
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
    whole = [
        AlignedWord(word, start, start + 0.4, ()) for word, start in zip(lyrics.split(), starts)
    ]
    windows = _phrase_windows(lyrics, heard, 45, whole)
    assert any(w.first == 4 and w.heard_start == 10 for w in windows)
    assert any(w.first == 7 and w.heard_start == 20 for w in windows)


def test_a_unique_recognized_word_cannot_cross_the_surrounding_phrase_anchors():
    import difflib
    from backend.ai_worker.speech import _unique_anchors

    words = "first refrain signal last refrain".split()
    heard = [("signal", 50.0, 50.5)]
    blocks = [difflib.Match(0, 0, 2), difflib.Match(3, 2, 2)]
    expanded = [
        ("first", 10.0, 11.0),
        ("refrain", 11.0, 12.0),
        ("last", 30.0, 31.0),
        ("refrain", 31.0, 32.0),
    ]

    _unique_anchors(words, heard, blocks, expanded)

    assert len(blocks) == 2, "a later ASR occurrence cannot anchor an earlier gap"


def test_local_boundary_improvement_is_not_diluted_by_unchanged_words():
    from backend.ai_worker.ctc import _preferred

    unchanged = [AlignedWord("rest", 30 + i, 30.5 + i, (), 0.9) for i in range(18)]
    reference = [
        AlignedWord("first", 9, 9.2, (), 0.03),
        AlignedWord("second", 10, 29.2, (), 0.10),
        *unchanged,
    ]
    guided = [
        AlignedWord("first", 28, 28.5, (), 0.18),
        AlignedWord("second", 28.6, 29.2, (), 0.07),
        *unchanged,
    ]

    assert _preferred(guided, reference, 0, {}, None) is guided


def test_independent_recognition_can_settle_one_bad_word_inside_an_otherwise_correct_phrase():
    from backend.ai_worker.ctc import _preferred

    unchanged = [AlignedWord("rest", 10 + i, 10.5 + i, (), 0.9) for i in range(18)]
    guided = [*unchanged, AlignedWord("last", 30, 31, (), 0.2)]
    reference = [*unchanged, AlignedWord("last", 40, 41, (), 0.9)]
    heard = {i: word.start for i, word in enumerate(guided)}

    assert _preferred(guided, reference, 0, heard, None) is guided


def test_an_accepted_repeat_cannot_be_followed_by_words_from_the_previous_repeat(monkeypatch):
    import torch
    from backend.ai_worker import ctc

    whole = [AlignedWord("first", 20, 21, (), 0.9), AlignedWord("next", 12, 13, (), 0.9)]
    guided = [whole[0], AlignedWord("next", 22, 23, (), 0.4)]
    monkeypatch.setattr(ctc, "_align_window", lambda _s, _step, _chunk, w: [guided[w.first]])
    result = ctc.align_guided(
        torch.empty(0),
        0.02,
        ["first", "next"],
        [ctc.Window(0, 1, 19, 21), ctc.Window(1, 2, 21, 24)],
        whole=whole,
    )

    assert result[1].start == 22, "choose the current phrase before chronological clamping"


def test_untranscribed_leading_audio_stays_outside_the_first_word():
    import torch
    from backend.ai_worker.ctc import align_words

    # Cached acoustic emissions are test input. The independently recognized source verse
    # enters around 29 s; the preceding instrumental break must not become its first word.
    with np.load(Path(__file__).with_name("fixtures") / "wildways-verse-entry.npz") as fixture:
        words = align_words(
            torch.from_numpy(fixture["scores"]),
            0.02,
            str(fixture["lyrics"]).split(),
            float(fixture["offset"]),
        )

    assert 28.0 <= words[0].start <= 29.3
    assert words[1].end < 29.5


def test_a_number_written_as_digits_keeps_its_sung_interval_before_the_next_word():
    import torch
    from backend.ai_worker.ctc import align_words

    with np.load(Path(__file__).with_name("fixtures") / "wildways-verse-entry.npz") as fixture:
        words = align_words(
            torch.from_numpy(fixture["number_scores"]),
            0.02,
            ["23", "этаж,", "будто", "новый", "рассказ"],
            66.0,
        )

    assert words[0].text == "23", "pronunciation must not rewrite the displayed catalogue spelling"
    assert 66.0 <= words[0].start < 67.5
    assert words[0].end - words[0].start > 0.4
    assert words[0].end <= words[1].start
    assert len(words[0].letters) == 2


def test_a_catalog_line_confirmed_by_a_voice_onset_supplies_a_timing_anchor():
    from backend.ai_worker.speech import _hint_windows

    windows = _hint_windows(
        "carry our voices", [{"start": 10.0, "text": "carry our voices"}], 20.0, np.array([10.2])
    )

    assert windows[0].heard_start == pytest.approx(10.2)


def test_a_catalog_entry_remains_a_soft_anchor_when_no_nearby_onset_is_detected():
    from backend.ai_worker.speech import _hint_windows

    windows = _hint_windows(
        "carry our voices", [{"start": 10.0, "text": "carry our voices"}], 20.0, np.empty(0)
    )

    assert windows[0].heard_start == 10.0


@pytest.mark.parametrize("early_recognized_prefix", [False, True])
def test_actual_verse_entry_survives_missing_first_words_in_independent_recognition(
    monkeypatch, early_recognized_prefix
):
    import json
    import torch
    from backend.ai_worker import speech

    with np.load(Path(__file__).with_name("fixtures") / "wildways-verse-entry.npz") as fixture:
        scores = torch.from_numpy(fixture["prefix_scores"])
        case = json.loads(str(fixture["prefix_metadata"]))
    heard = case["heard"]
    if early_recognized_prefix:
        heard = sorted(
            [*heard, [speech._key(case["lyrics"].split()[7]), 9.4, 28.7]], key=lambda w: w[1]
        )
    monkeypatch.setattr(speech, "read_mono", lambda *_: np.zeros(40 * _RATE, dtype=np.float32))
    monkeypatch.setattr(speech, "_alignment_evidence", lambda *_: (scores, 0.02, heard))
    monkeypatch.setattr(speech, "vocal_onsets", lambda *_: np.array([28.18]))
    monkeypatch.setattr(speech, "voiced_frames", lambda *_: np.ones(4000, dtype=bool))
    monkeypatch.setattr(speech, "with_voice_onsets", lambda words, *_: words)
    monkeypatch.setattr(speech, "with_sung_ends", lambda words, *_: words)

    result = speech.align(Path("voice.wav"), case["lyrics"], "Russian", case["hints"])

    assert 28.0 <= result["words"][7]["start"] <= 29.3


def test_catalog_and_recognized_phrase_jointly_keep_a_short_line_out_of_the_following_pause():
    from backend.ai_worker.speech import _alignment_windows

    lyrics = "carry our voices\nreturn to shore"
    heard = [
        (word, start, start + 0.3)
        for word, start in zip(lyrics.split(), (2.0, 2.3, 2.7, 20.0, 20.3, 20.7))
    ]
    hints = [{"start": 2.0, "text": "carry our voices"}, {"start": 20.0, "text": "return to shore"}]
    whole = [
        AlignedWord(word, start, start + 0.3, (), 0.8)
        for word, start in zip(lyrics.split(), (5.0, 6.0, 7.0, 20.0, 20.3, 20.7))
    ]

    windows = _alignment_windows(lyrics, hints, heard, whole, np.zeros(24 * _RATE))

    assert windows[0].heard_start == 2.0
    assert windows[0].end == pytest.approx(3.6)


def test_an_early_coarse_asr_entry_still_bounds_phonemes_when_it_spans_the_catalog_entry():
    from backend.ai_worker.speech import _alignment_windows

    lyrics = "carry our voices\nreturn to shore"
    heard = [
        (word, start, start + 0.3)
        for word, start in zip(lyrics.split(), (1.0, 1.5, 2.0, 20.0, 20.3, 20.7))
    ]
    hints = [{"start": 2.0, "text": "carry our voices"}, {"start": 20.0, "text": "return to shore"}]
    whole = [
        AlignedWord(word, start, start + 0.3, (), 0.8)
        for word, start in zip(lyrics.split(), (5.0, 6.0, 7.0, 20.0, 20.3, 20.7))
    ]

    windows = _alignment_windows(lyrics, hints, heard, whole, np.zeros(24 * _RATE))

    assert windows[0].start <= 2.0
    assert windows[0].end == pytest.approx(2.9)


def test_a_long_asr_prefix_padding_cannot_move_a_catalog_entry_into_an_instrumental_break():
    from backend.ai_worker.speech import _alignment_windows

    lyrics = "carry our voices\nreturn to shore"
    heard = [
        ("carry", 0.0, 9.3),
        ("our", 9.3, 9.6),
        ("voices", 9.6, 10.0),
        ("return", 20.0, 20.3),
        ("to", 20.3, 20.6),
        ("shore", 20.6, 21.0),
    ]
    hints = [{"start": 9.0, "text": "carry our voices"}, {"start": 20.0, "text": "return to shore"}]
    whole = [
        AlignedWord(word, start, start + 0.3, (), 0.8)
        for word, start in zip(lyrics.split(), (0.0, 9.3, 9.6, 20.0, 20.3, 20.6))
    ]

    windows = _alignment_windows(lyrics, hints, heard, whole, np.zeros(24 * _RATE))

    assert windows[0].heard_start == 9.0


def test_a_catalog_entry_and_a_supported_last_word_can_bound_a_partly_recognized_phrase():
    from backend.ai_worker.speech import _alignment_windows

    lyrics = "carry our voices\nreturn to shore"
    heard = [
        (word, start, start + 0.3)
        for word, start in zip(("voices", "return", "to", "shore"), (2.7, 20.0, 20.3, 20.7))
    ]
    hints = [{"start": 2.0, "text": "carry our voices"}, {"start": 20.0, "text": "return to shore"}]
    whole = [
        AlignedWord(word, start, start + 0.3, (), 0.01)
        for word, start in zip(lyrics.split(), (5.0, 6.0, 7.0, 20.0, 20.3, 20.7))
    ]

    windows = _alignment_windows(lyrics, hints, heard, whole, np.zeros(24 * _RATE))

    assert windows[0].end == pytest.approx(3.6)


def test_actual_short_reply_does_not_pull_the_previous_vowel_into_a_long_pause(monkeypatch):
    import json
    import torch
    from backend.ai_worker import speech

    with np.load(Path(__file__).with_name("fixtures") / "wildways-verse-entry.npz") as fixture:
        case = json.loads(str(fixture["reply_metadata"]))
        vocal, backing = fixture["reply_vocal"], fixture["reply_instrumental"]
        scores = torch.from_numpy(fixture["reply_scores"])
    monkeypatch.setattr(
        speech, "read_mono", lambda path, *_: backing if path.name == "backing.wav" else vocal
    )
    monkeypatch.setattr(speech, "_alignment_evidence", lambda *_: (scores, 0.02, case["heard"]))

    result = speech.align(
        Path("voice.wav"), case["lyrics"], "Russian", case["hints"], Path("backing.wav")
    )
    words = result["words"]

    # Source recognition and raw spectrogram put this articulated reply around 123–126 s.
    # These broad bounds exclude the subsequent instrumental break, not a claimed ms reference.
    assert 13.0 < words[13]["start"] < 14.5
    assert words[15]["end"] < 16.2
    assert words[12]["end"] <= words[13]["start"]
    assert words[11]["start"] < words[12]["start"] < words[12]["end"]


@pytest.mark.parametrize("fixture_prefix", ["fast", "native_fast"])
def test_actual_internal_word_run_does_not_flash_a_word_before_its_sung_syllable(
    monkeypatch, fixture_prefix
):
    import json
    import torch
    from backend.ai_worker import speech

    with np.load(Path(__file__).with_name("fixtures") / "wildways-verse-entry.npz") as fixture:
        case = json.loads(str(fixture[fixture_prefix + "_metadata"]))
        vocal, backing = (
            fixture[fixture_prefix + "_vocal"],
            fixture[fixture_prefix + "_instrumental"],
        )
        scores = torch.from_numpy(fixture[fixture_prefix + "_scores"])
    monkeypatch.setattr(
        speech, "read_mono", lambda path, *_: backing if path.name == "backing.wav" else vocal
    )
    monkeypatch.setattr(speech, "_alignment_evidence", lambda *_: (scores, 0.02, case["heard"]))

    words = speech.align(
        Path("voice.wav"), case["lyrics"], "Russian", case["hints"], Path("backing.wav")
    )["words"]

    # Independent recognition of both original mix and vocal puts these syllables at
    # ~59.6–60.4 and ~60.4–61.1 s. Preserve their order, not a 40-ms artificial flash.
    assert words[2]["start"] > 2.5
    assert words[2]["end"] - words[2]["start"] > 0.3
    assert 3.0 < words[3]["start"] < 4.2
    assert 4.0 < words[4]["start"] < 5.2
    assert words[2]["end"] <= words[3]["start"] < words[4]["start"]


def test_recognized_word_intervals_preserve_a_genuine_fast_cluster(monkeypatch):
    from backend.ai_worker import speech

    words = [
        AlignedWord(text, start, end, (start,), 0.03)
        for text, start, end in (("I", 1, 1.03), ("a", 1.03, 1.06), ("go", 1.06, 1.3))
    ]
    heard = [(word.text.casefold(), word.start, word.end) for word in words]
    monkeypatch.setattr(speech, "read_mono", lambda *_: _signal([(1, 1.3)], 2))
    monkeypatch.setattr(speech, "_alignment_evidence", lambda *_: ("unused", 0.02, heard))
    monkeypatch.setattr(speech, "align_words", lambda *_: words)
    monkeypatch.setattr(speech, "align_guided", lambda *_: words)
    monkeypatch.setattr(speech, "with_voice_onsets", lambda value, *_: value)
    monkeypatch.setattr(speech, "with_sung_ends", lambda value, *_: value)

    result = speech.align(Path("voice.wav"), "I a go", "English")["words"]

    assert [(word["start"], word["end"]) for word in result] == [
        (1, 1.03),
        (1.03, 1.06),
        (1.06, 1.3),
    ]


def test_a_supported_word_run_does_not_cap_a_quiet_long_vowel_at_its_asr_endpoint(monkeypatch):
    from backend.ai_worker import speech

    words = [
        AlignedWord(text, start, end, (start,), 0.02)
        for text, start, end in (("we", 1, 1.2), ("stay", 2, 2.3), ("here", 12.5, 12.8))
    ]
    heard = [(word.text, word.start, word.end) for word in words]
    samples = 0.03 * _signal([(1, 1.2), (2, 12), (12.5, 12.8)], 14)
    monkeypatch.setattr(speech, "read_mono", lambda *_: samples)
    monkeypatch.setattr(speech, "_alignment_evidence", lambda *_: ("unused", 0.02, heard))
    monkeypatch.setattr(speech, "align_words", lambda *_: words)
    monkeypatch.setattr(speech, "align_guided", lambda *_: words)

    result = speech.align(Path("voice.wav"), "we stay here", "English")["words"]

    assert result[1]["end"] == pytest.approx(12.0, abs=0.1)


def test_a_recognition_run_cannot_replace_strong_acoustic_cores_with_weak_late_tokens(monkeypatch):
    import torch
    from backend.ai_worker import ctc, speech

    words = [
        AlignedWord(text, i + 1, i + 1.2, (float(i + 1),), 0.9)
        for i, text in enumerate(("we", "sing", "here"))
    ]
    heard = [(word.text, word.start + 1, word.end + 1) for word in words]
    monkeypatch.setattr(speech, "read_mono", lambda *_: _signal([(1, 6)], 7))
    monkeypatch.setattr(
        speech, "_alignment_evidence", lambda *_: (torch.zeros(350, 28), 0.02, heard)
    )
    monkeypatch.setattr(speech, "align_words", lambda *_: words)
    monkeypatch.setattr(speech, "align_guided", lambda *_: words)
    monkeypatch.setattr(
        ctc,
        "_align_window",
        lambda _s, _step, chunk, w: [
            AlignedWord(chunk[0], w.start, w.start + 0.2, (w.start,), 0.1)
        ],
    )
    monkeypatch.setattr(speech, "with_voice_onsets", lambda value, *_: value)
    monkeypatch.setattr(speech, "with_sung_ends", lambda value, *_: value)

    result = speech.align(Path("voice.wav"), "we sing here", "English")["words"]

    assert [word["start"] for word in result] == [1, 2, 3]


def test_a_supported_phonetic_core_inside_a_coarse_word_interval_beats_an_approximation():
    from backend.ai_worker.word_guidance import _select_sequence

    original = AlignedWord("stay", 1, 1.4, (1,), 0.01)
    phonetic = AlignedWord("stay", 2.6, 3, (2.6,), 0.02)
    approximate = AlignedWord("stay", 2, 3, (2,), 0)

    result = _select_sequence(
        [original], [[original, phonetic, approximate]], {0: (2, 3)}, 0, np.ones(400, dtype=bool)
    )

    assert result == [phonetic]


def test_one_inconsistent_recognition_run_does_not_cancel_an_unrelated_valid_correction(
    monkeypatch,
):
    import torch
    from backend.ai_worker import ctc
    from backend.ai_worker.word_guidance import with_word_guidance

    words = [
        AlignedWord(str(i), start, start + 0.2, (float(start),), 0.01)
        for i, start in enumerate((1, 2, 3, 10, 11, 12))
    ]
    monkeypatch.setattr(
        ctc,
        "_align_window",
        lambda _s, _step, chunk, w: [
            AlignedWord(chunk[0], w.start + 0.1, w.start + 0.3, (w.start + 0.1,), 0.01)
        ],
    )

    result = with_word_guidance(
        words,
        torch.zeros(1000, 28),
        0.02,
        [ctc.Window(0, 3, 0, 6), ctc.Window(3, 6, 9, 14)],
        {0: (2.4, 2.8), 3: (10.5, 10.9)},
        np.ones(2000, dtype=bool),
        0.6,
    )

    assert result[:3] == words[:3], "reject only the run whose corrected order is inconsistent"
    assert result[3].start == pytest.approx(10.6)


@pytest.mark.parametrize("fixture_prefix", ["alternative", "native_reply", "native_reply7"])
def test_actual_alternative_stem_keeps_a_short_reply_out_of_the_instrumental_break(
    monkeypatch, fixture_prefix
):
    import json
    import torch
    from backend.ai_worker import speech

    with np.load(Path(__file__).with_name("fixtures") / "wildways-verse-entry.npz") as fixture:
        case = json.loads(str(fixture[fixture_prefix + "_metadata"]))
        scores = torch.from_numpy(fixture[fixture_prefix + "_scores"])
    monkeypatch.setattr(speech, "read_mono", lambda *_: np.zeros(40 * _RATE, dtype=np.float32))
    monkeypatch.setattr(speech, "_alignment_evidence", lambda *_: (scores, 0.02, case["heard"]))
    monkeypatch.setattr(speech, "vocal_onsets", lambda *_: np.empty(0))
    monkeypatch.setattr(speech, "voiced_frames", lambda *_: np.ones(4000, dtype=bool))
    monkeypatch.setattr(speech, "with_voice_onsets", lambda words, *_: words)
    monkeypatch.setattr(speech, "with_sung_ends", lambda words, *_: words)

    words = speech.align(Path("voice.wav"), case["lyrics"], "Russian", case["hints"])["words"]

    assert 13.0 < words[13]["start"] < 15.0
    assert words[15]["end"] < 16.2
    assert words[14]["end"] - words[14]["start"] > 0.2
    assert words[14]["start"] < 14.8


def test_a_misrecognized_prefix_keeps_its_word_order_before_a_supported_last_word(monkeypatch):
    import json
    import torch
    from backend.ai_worker import speech

    with np.load(Path(__file__).with_name("fixtures") / "wildways-verse-entry.npz") as fixture:
        case = json.loads(str(fixture["stable_reply_metadata"]))
        scores = torch.from_numpy(fixture["stable_reply_scores"])
        vocal = np.pad(fixture["stable_reply_vocal"], (13 * _RATE, 24 * _RATE))
        backing = np.pad(fixture["stable_reply_instrumental"], (13 * _RATE, 24 * _RATE))
    monkeypatch.setattr(
        speech, "read_mono", lambda path, *_: backing if path.name == "backing.wav" else vocal
    )
    monkeypatch.setattr(speech, "_alignment_evidence", lambda *_: (scores, 0.02, case["heard"]))
    monkeypatch.setattr(speech, "vocal_onsets", lambda *_: np.empty(0))
    monkeypatch.setattr(speech, "voiced_frames", lambda *_: np.ones(4000, dtype=bool))
    monkeypatch.setattr(speech, "with_voice_onsets", lambda words, *_: words)

    words = speech.align(
        Path("voice.wav"), case["lyrics"], "Russian", case["hints"], Path("backing.wav")
    )["words"]

    # Original performance: the short reply precedes the instrumental break. Recognition
    # hears only its last word correctly; the prefix still needs its own phonetic search.
    assert 13 < words[13]["start"] < words[14]["start"] < 14.8
    assert words[14]["end"] - words[14]["start"] > 0.2
    assert words[14]["end"] <= words[15]["start"]
    assert words[15]["end"] < 16.2


def test_locally_recognized_utterance_can_bound_misspelled_words_without_replacing_the_text():
    from backend.ai_worker.speech import _alignment_windows

    lyrics = "carry our voices\nreturn to shore"
    heard = [
        ("carried", 2, 2.5),
        ("voces", 2.5, 3),
        ("return", 20, 20.3),
        ("to", 20.3, 20.6),
        ("shore", 20.6, 21),
    ]
    hints = [{"start": 2, "text": "carry our voices"}, {"start": 20, "text": "return to shore"}]
    whole = [
        AlignedWord(word, start, start + 0.2, (), 0.01)
        for word, start in zip(lyrics.split(), (5, 6, 7, 20, 20.3, 20.6))
    ]

    windows = _alignment_windows(lyrics, hints, heard, whole, np.zeros(24 * _RATE))

    assert windows[0].end == pytest.approx(3.6)
    assert windows[0].heard_start == 2


def test_unrelated_recognition_without_surrounding_phrase_support_cannot_shorten_a_long_phrase():
    from backend.ai_worker.speech import _alignment_windows

    lyrics = "carry our voices\nreturn to shore"
    heard = [("unrelated", 10, 10.5), ("utterance", 10.5, 11)]
    hints = [{"start": 10, "text": "carry our voices"}, {"start": 20, "text": "return to shore"}]
    whole = [
        AlignedWord(word, start, start + 0.2, (), 0.8)
        for word, start in zip(lyrics.split(), (10, 12, 18, 20, 20.3, 20.6))
    ]

    windows = _alignment_windows(lyrics, hints, heard, whole, np.zeros(24 * _RATE))

    assert windows[0].end == pytest.approx(20.6)


@pytest.mark.parametrize("candidate_start", [1.8, 1.81])
def test_a_word_correction_cannot_collapse_its_neighbour_to_a_tied_start(
    monkeypatch, candidate_start
):
    import torch
    from backend.ai_worker import ctc
    from backend.ai_worker.word_guidance import with_word_guidance

    words = [
        AlignedWord(text, start, start + 0.3, (start,), 0.01)
        for text, start in (("we", 1), ("sing", 1.8), ("here", 2.6))
    ]
    monkeypatch.setattr(
        ctc,
        "_align_window",
        lambda _s, _step, chunk, w: [
            AlignedWord(chunk[0], candidate_start, 2.1, (candidate_start,), 0.02)
        ],
    )

    result = with_word_guidance(
        words,
        torch.zeros(200, 28),
        0.02,
        [ctc.Window(0, 3, 0, 4)],
        {2: (1.8, 2.1)},
        np.ones(400, bool),
        0.6,
    )

    assert result == words


@pytest.mark.parametrize("prefix", ["overlap", "uncertain"])
def test_a_recognized_word_overlapping_the_next_coarse_window_still_guides_its_own_phrase(
    monkeypatch, prefix
):
    import json
    import torch
    from backend.ai_worker import speech

    with np.load(Path(__file__).with_name("fixtures") / "wildways-verse-entry.npz") as fixture:
        case = json.loads(str(fixture[prefix + "_metadata"]))
        scores = torch.from_numpy(fixture[prefix + "_scores"])
    monkeypatch.setattr(speech, "read_mono", lambda *_: np.zeros(16 * _RATE, np.float32))
    monkeypatch.setattr(speech, "_alignment_evidence", lambda *_: (scores, 0.02, case["heard"]))
    monkeypatch.setattr(speech, "vocal_onsets", lambda *_: np.array(case["onsets"]))
    monkeypatch.setattr(speech, "voiced_frames", lambda *_: np.ones(1600, bool))
    monkeypatch.setattr(speech, "with_voice_onsets", lambda words, *_: words)
    monkeypatch.setattr(speech, "with_sung_ends", lambda words, *_: words)

    words = speech.align(Path("voice.wav"), case["lyrics"], "Russian", case["hints"])["words"]

    assert words[9]["start"] < 9.5
    assert words[8]["end"] <= words[9]["start"]


def test_a_mostly_unrecognized_word_uses_its_speech_span_instead_of_false_character_precision():
    from backend.ai_worker.word_guidance import _character_intervals

    hints = _character_intervals(
        "we carry starlight home".split(),
        [("we", 1, 1.2), ("carry", 1.2, 2), ("night", 2, 3), ("home", 3, 4)],
        0,
    )

    assert hints[2] == (2, 3)


@pytest.mark.parametrize("threads", [1, 2])
def test_whole_song_recognition_does_not_copy_catalogue_text_into_unheard_audio(
    monkeypatch, threads
):
    import torch
    from backend.ai_worker import speech

    lyrics = "opening line\n" * 50 + "later vocabulary"
    prompts = []
    monkeypatch.setattr(speech, "cpu_threads", lambda: threads)
    monkeypatch.setattr(torch, "set_num_threads", lambda *_: None)
    monkeypatch.setattr(speech, "emission", lambda *_: (torch.zeros(1, 28), 0.02))
    monkeypatch.setattr(
        speech,
        "_guidance",
        lambda _p, _l, prompt, _t, **_options: prompts.append(prompt) or {"segments": []},
    )

    speech._alignment_evidence(Path("voice.wav"), np.zeros(_RATE), "English", lyrics)

    assert prompts == [None]


@pytest.mark.parametrize("threads", [1, 4])
def test_alignment_uses_the_same_recognition_backend_independently_of_the_ctc_device(
    monkeypatch, threads
):
    import torch
    from backend.ai_worker import speech

    choices = []
    monkeypatch.setattr(speech, "cpu_threads", lambda: threads)
    monkeypatch.setattr(speech, "device", lambda: "cuda")
    monkeypatch.setattr(torch, "set_num_threads", lambda *_: None)
    monkeypatch.setattr(speech, "emission", lambda *_: (torch.zeros(1, 28), 0.02))
    monkeypatch.setattr(
        speech,
        "_guidance",
        lambda *_args, **options: (
            choices.append(options.get("prefer_accelerated", False)) or {"segments": []}
        ),
    )

    speech._alignment_evidence(Path("voice.wav"), np.zeros(_RATE), "English", "we sing here")

    assert choices == [True]


@pytest.mark.parametrize("start,score,expected", [(1, 0.01, 1.6), (1, 0.9, 1), (1.2, 0.01, 1.2)])
def test_a_missing_prefix_does_not_treat_a_weak_crop_edge_as_a_sung_entry(
    monkeypatch, start, score, expected
):
    import torch
    from backend.ai_worker import ctc
    from backend.ai_worker.word_guidance import _unrecognized_runs

    first = AlignedWord("we", start, start + 0.02, (start,), score)
    candidates = [first, AlignedWord("carry", 2.5, 3, (2.5,), 0.1)]
    words = [
        AlignedWord("we", 4, 4.02, (4,), 0.01),
        AlignedWord("carry", 4.2, 4.4, (4.2,), 0.01),
        AlignedWord("here", 4.4, 4.6, (4.4,), 0.01),
    ]
    monkeypatch.setattr(ctc, "_align_window", lambda *_: candidates)

    result = _unrecognized_runs(
        words,
        torch.zeros(300, 28),
        0.02,
        ctc.Window(0, 3, 1, 5, 1.6),
        {2: (3.5, 4)},
        np.ones(600, bool),
    )

    assert result[0][1].start == expected
    assert result[1][1] == candidates[1]


def test_a_partly_recognized_phrase_cannot_move_a_catalogued_entry_to_its_later_words():
    from backend.ai_worker.speech import _alignment_windows

    lyrics = "carry our voices\nreturn to shore"
    heard = [
        (word, start, start + 0.3)
        for word, start in zip(
            ("our", "voices", "return", "to", "shore"), (5.3, 5.7, 20.0, 20.3, 20.7)
        )
    ]
    whole = [
        AlignedWord(word, start, start + 0.3, (), 0.8)
        for word, start in zip(lyrics.split(), (2.0, 5.3, 5.7, 20.0, 20.3, 20.7))
    ]
    hints = [{"start": 2.0, "text": "carry our voices"}, {"start": 20.0, "text": "return to shore"}]

    windows = _alignment_windows(lyrics, hints, heard, whole, np.zeros(24 * _RATE))

    assert windows[0].start <= 2.0, "a missing prefix still needs room to be aligned"


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
    whole = [
        AlignedWord(word, index * 4 + 2.5, index * 4 + 3.0, ()) for index, word in enumerate(words)
    ]

    shifted = _shifted_hints(words, hints, whole)

    assert [item["start"] for item in shifted] == pytest.approx(
        [index * 4 + 2.5 for index in range(10)]
    )


def test_catalog_timings_that_already_fit_are_left_alone() -> None:
    from backend.ai_worker.speech import _shifted_hints

    words = "a b c d e f".split()
    hints = [{"start": float(index * 4), "text": word} for index, word in enumerate(words)]
    whole = [
        AlignedWord(word, index * 4 + 0.1, index * 4 + 0.5, ()) for index, word in enumerate(words)
    ]

    assert [item["start"] for item in _shifted_hints(words, hints, whole)] == [
        index * 4.0 for index in range(6)
    ]


def test_whisper_settles_which_phrase_a_word_belongs_to_when_the_model_is_unsure() -> None:
    from backend.ai_worker.ctc import _preferred

    # The model is more confident in "stay" on the next phrase, but Whisper heard it on the first one.
    guided = [
        AlignedWord("please", 1.0, 2.2, (1.0,), 0.06),
        AlignedWord("stay", 2.5, 3.5, (2.5,), 0.06),
    ]
    whole = [
        AlignedWord("please", 1.0, 3.5, (1.0,), 0.13),
        AlignedWord("stay", 4.9, 5.1, (4.9,), 0.13),
    ]
    voiced = voiced_frames(_signal([(1.0, 2.2), (2.5, 3.5), (4.9, 5.4)], 6.0), _RATE, _HOP)

    chosen = _preferred(guided, whole, 0, {0: 1.2, 1: 2.6}, voiced)

    assert [word.start for word in chosen] == [1.0, 2.5]


def test_whisper_is_not_followed_into_silence() -> None:
    from backend.ai_worker.ctc import _preferred

    # Whisper's (wrong) times favour the placement that starts "stay" where nothing is sung.
    guided = [
        AlignedWord("please", 1.0, 2.2, (1.0,), 0.06),
        AlignedWord("stay", 3.8, 4.0, (3.8,), 0.06),
    ]
    whole = [
        AlignedWord("please", 1.0, 2.2, (1.0,), 0.13),
        AlignedWord("stay", 2.5, 3.5, (2.5,), 0.13),
    ]
    voiced = voiced_frames(_signal([(1.0, 2.2), (2.5, 3.5)], 6.0), _RATE, _HOP)

    chosen = _preferred(guided, whole, 0, {0: 1.0, 1: 3.9}, voiced)

    assert [word.start for word in chosen] == [1.0, 2.5]


def test_a_weak_but_better_phonetic_core_inside_its_phrase_beats_a_later_echo() -> None:
    from backend.ai_worker.ctc import _preferred

    guided = [AlignedWord("stay", 2.5, 3.5, (2.5,), 0.009)]
    reference = [AlignedWord("stay", 5.0, 8.0, (5.0,), 0.005)]
    voiced = voiced_frames(_signal([(2.5, 3.5), (5.0, 8.0)], 9.0), _RATE, _HOP)

    chosen = _preferred(guided, reference, 0, {}, voiced)

    assert chosen == guided, "an absolute confidence margin cannot privilege the worse placement"


def test_clean_import_recovers_a_phrase_missing_from_full_recording_recognition(monkeypatch):
    import json
    import torch
    from backend.ai_worker import speech
    from backend.ai_worker.ctc import Window

    # Raw emissions and independent ASR from the first processing of a new import.
    with np.load(Path(__file__).with_name("fixtures") / "wildways-verse-entry.npz") as fixture:
        case = json.loads(str(fixture["clean_reply_metadata"]))
        scores = torch.from_numpy(fixture["clean_reply_scores"])
    whole = [AlignedWord(**item) for item in case["whole"]]
    windows = [Window(**item) for item in case["windows"]]
    monkeypatch.setattr(speech, "read_mono", lambda *_: np.zeros(37 * _RATE, np.float32))
    monkeypatch.setattr(speech, "_alignment_evidence", lambda *_: (scores, 0.02, case["heard"]))
    monkeypatch.setattr(speech, "align_words", lambda *_: whole)
    monkeypatch.setattr(speech, "_alignment_windows", lambda *_: windows)
    monkeypatch.setattr(speech, "voiced_frames", lambda *_: np.ones(3701, bool))
    monkeypatch.setattr(speech, "with_voice_onsets", lambda words, *_: words)
    monkeypatch.setattr(speech, "with_sung_ends", lambda words, *_: words)
    local = {
        "segments": [{"words": [dict(word=k, start=a, end=b) for k, a, b in case["recognized"]]}]
    }
    monkeypatch.setattr(
        speech, "_accelerated_guidance", lambda *_, **_kw: {"contexts": [local] * len(windows)}
    )

    words = speech.align(Path("voice.wav"), " ".join(w.text for w in whole), "Russian")["words"]

    assert 10 < words[7]["start"] < 11  # held word belongs to the earlier phrase
    assert all(13 < w["start"] < 16 for w in words[8:11])  # reply precedes the instrumental
    assert words[10]["end"] < 17


def test_coarse_recognition_span_is_not_a_license_to_start_a_weak_word_at_its_end():
    from backend.ai_worker.word_guidance import _select_sequence

    late = AlignedWord("we", 4.0, 4.2, (4.0, 4.1), 0.01)
    near_entry = AlignedWord("we", 3.1, 3.5, (3.1, 3.3), 0.005)
    chosen = _select_sequence([late], [[late, near_entry]], {0: (3.0, 4.2)}, 0, np.ones(600, bool))

    assert chosen == [near_entry]


@pytest.mark.parametrize("next_start", [4.0, 6.0])
def test_context_recognition_can_recover_words_outside_a_wrongly_short_first_asr_window(next_start):
    from backend.ai_worker.ctc import Window
    from backend.ai_worker.recognition import contextual_guidance

    words = "we sing a long ending then another line".split()
    whole = [AlignedWord(w, i + 1.0, i + 1.5, (), 0.01) for i, w in enumerate(words)]
    windows = [Window(0, 5, 0.5, 3, 1), Window(5, 8, next_start, 10, next_start)]
    heard = {i: (i + 1.0, i + 1.5) for i in range(3)}
    local = {
        "segments": [
            {"words": [dict(word=w, start=i + 1.0, end=i + 1.5) for i, w in enumerate(words[:5])]}
        ]
    }

    revised, supported = contextual_guidance(
        words,
        windows,
        whole,
        heard,
        np.ones(1000, bool),
        lambda contexts: {"contexts": [local for _ in contexts]},
    )

    assert revised[0].end > 5.5
    assert supported[4] == (5.0, 5.5)


def test_recognition_margin_does_not_move_a_word_into_the_previous_syllable():
    from backend.ai_worker.word_guidance import _select_sequence

    before = AlignedWord("we", 2.6, 3.5, (2.6, 2.8), 0.01)
    within = AlignedWord("we", 3.1, 3.5, (3.1, 3.3), 0.005)
    assert _select_sequence(
        [before], [[before, within]], {0: (3.0, 4.2)}, 0, np.ones(500, bool)
    ) == [within]


def test_a_strong_word_average_does_not_hide_its_unsupported_first_phoneme(monkeypatch):
    import torch
    from backend.ai_worker import ctc, word_guidance

    word = AlignedWord("we", 4.0, 4.2, (4.0, 4.1), 0.3)
    approximate = AlignedWord("we", 3.0, 3.5, (3.0, 3.2), 0.0)
    scores = torch.zeros(300, 28)
    first_token = ctc._character_tokens("we")[0][0]
    scores[200, first_token] = np.log(0.001)
    monkeypatch.setattr(word_guidance, "_core_candidates", lambda *_: [approximate])

    candidates = word_guidance._candidates(
        word, scores, 0.02, ctc.Window(0, 1, 0, 5), (3.0, 3.5), np.ones(500, bool), 0.6
    )

    assert candidates == [approximate]


def test_fresh_phrase_recovery_preserves_the_acoustic_entry_after_the_previous_vowel(monkeypatch):
    import json
    import torch
    from backend.ai_worker import speech
    from backend.ai_worker.ctc import Window

    with np.load(Path(__file__).with_name("fixtures") / "wildways-verse-entry.npz") as f:
        case = json.loads(str(f["clean_entry_metadata"]))
        scores = torch.from_numpy(f["clean_entry_scores"])
        vocal, backing = (
            f["clean_entry_vocal"].astype(np.float32),
            f["clean_entry_instrumental"].astype(np.float32),
        )
    whole = [AlignedWord(**w) for w in case["whole"]]
    monkeypatch.setattr(
        speech, "read_mono", lambda path, *_: backing if path.name == "backing.wav" else vocal
    )
    monkeypatch.setattr(speech, "_alignment_evidence", lambda *_: (scores, 0.02, case["heard"]))
    monkeypatch.setattr(speech, "align_words", lambda *_: whole)
    monkeypatch.setattr(
        speech, "_alignment_windows", lambda *_: [Window(**w) for w in case["windows"]]
    )
    local = {
        "segments": [{"words": [dict(word=k, start=a, end=b) for k, a, b in case["recognized"]]}]
    }
    monkeypatch.setattr(
        speech,
        "_accelerated_guidance",
        lambda *_, contexts: {"contexts": [local for _ in contexts]},
    )

    words = speech.align(
        Path("voice.wav"),
        " ".join(w.text for w in whole),
        "Russian",
        instrumental=Path("backing.wav"),
    )["words"]

    # Original mix has a fresh vocal rise at ~65.4 s. Separate ASR windows put
    # the following word near65.9s; the earlier vowel must not consume its entry.
    assert 8.3 < words[8]["start"] < 8.9
    assert 8.5 < words[9]["start"] < 9.3
    assert words[9]["end"] - words[9]["start"] > 0.5
