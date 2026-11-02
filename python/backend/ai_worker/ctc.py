from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from functools import lru_cache
from math import ceil, prod
from types import MappingProxyType

import numpy as np
import torch
import torchaudio
import uroman
from num2words import num2words
from torchaudio.functional import forced_align, merge_tokens
from torchaudio.pipelines import MMS_FA
from torchaudio.pipelines._wav2vec2.utils import _extend_model

from backend.ai.catalog import ALIGNMENT_MODEL
from backend.ai_worker.paths import model_file
from backend.ai_worker.runtime import device
from backend.ai_worker.timing import (
    _BRIDGED_GAP_SECONDS,
    _bridged,
    _runs,
    audible_frames,
    continued_frames,
    harmonic_evidence,
    singing_frames,
    vocal_onsets,
    voiced_frames,
)
from backend.moment_spreading import spread_tied_moments

_CHUNK_SECONDS = 20.0
_CONTEXT_SECONDS = 2.0
_MINIMUM_WORD_SECONDS = 0.05
# A word is over once the voice has been silent this long; the model often keeps its last letter "sounding"
# through the pause until the next word, which would keep the word lit over silence.
_SILENCE_ENDS_WORD_SECONDS = 0.3
_PREFERENCE = 0.05
# Whisper's word times are coarse (a few tenths of a second), but they reliably tell which sung phrase a
# word belongs to. Two placements of a stretch that differ by more than this against them are not jitter.
_HEARD_DISAGREEMENT_SECONDS = 0.25
_SILENT_START_SECONDS = 0.06
_CRAMMED_WORD_SECONDS = 0.08
_PAUSE_SECONDS = 0.25
# The model marks a letter only "a little" after its sound begins (see with_voice_onsets below); a wider
# window than this risks locking onto a nearer but unrelated voiced region -- a breath, backing vocal, or
# the previous word's tail -- and moving a word by far more than any such lag ever really is.
_ONSET_SEARCH_BEFORE_SECONDS = 0.25
_ONSET_SEARCH_AFTER_SECONDS = 0.1
_LARGEST_LAG_SECONDS = 0.3
_VOICE_RATE = 16_000
_VOICE_HOP = 160
_NON_LETTERS = re.compile(r"[^a-z']")


@dataclass(frozen=True, slots=True)
class AlignedWord:
    text: str
    start: float
    end: float
    letters: tuple[float, ...]
    # Mean probability the model gave the word's letters where they were placed (0 when it had nothing to pronounce).
    score: float = 0.0
    # Keep destructive normalization visible to acoustic review and the saved report.
    diagnostics: tuple[str, ...] = ()


@lru_cache(maxsize=1)
def _romanizer() -> uroman.Uroman:
    return uroman.Uroman()


@lru_cache(maxsize=1)
def _model() -> torch.nn.Module:
    """The multilingual character-level CTC model of Meta's MMS forced aligner, loaded from the verified download."""
    with torch.device("meta"):
        model: torch.nn.Module = torchaudio.models.wav2vec2_model(**MMS_FA._params)  # noqa: SLF001 - private bundle config
    weights = torch.load(
        model_file(ALIGNMENT_MODEL), map_location="cpu", weights_only=True, mmap=True
    )
    # The checkpoint predicts 31 symbols; the pad, end and unknown markers (1..3) are not part of the alignment alphabet.
    keep = [0, *range(4, weights["aux.weight"].shape[0])]
    weights["aux.weight"], weights["aux.bias"] = (
        weights["aux.weight"][keep],
        weights["aux.bias"][keep],
    )
    model.load_state_dict(weights, assign=True)
    # Match MMS_FA.get_model() preprocessing while retaining verified local checkpoint loading.
    model = _extend_model(model, normalize_waveform=MMS_FA._normalize_waveform)  # noqa: SLF001
    return model.to(device()).eval()


def frame_stride_samples() -> int:
    return prod(
        stride
        for _, _, stride in MMS_FA._params["extractor_conv_layer_config"]  # noqa: SLF001
    )


def emission(samples: np.ndarray) -> tuple[torch.Tensor, float]:
    """Log-probabilities of the model's characters for every frame (16 kHz audio in), and the seconds one frame lasts.

    The song is read in overlapping chunks (the model's attention grows with the square of the length) and only the
    central part of each chunk is kept.
    """
    rate = MMS_FA.sample_rate
    audio = torch.from_numpy(samples)
    chunk, context = int(_CHUNK_SECONDS * rate), int(_CONTEXT_SECONDS * rate)
    parts: list[torch.Tensor] = []
    # Valid convolutions omit their final incomplete receptive field; input length / output count is
    # therefore not the frame stride. Using that ratio both drops frames at chunk seams and gradually
    # stretches the concatenated time axis. All chunks use the extractor's fixed sample stride.
    frame_samples = frame_stride_samples()
    with torch.inference_mode():
        for start in range(0, len(audio), chunk):
            begin, end = max(0, start - context), min(len(audio), start + chunk + context)
            logits, _ = _model()(audio[begin:end][None].to(device()))
            scores = torch.log_softmax(logits, dim=-1)[0].cpu()
            first = (start - begin) // frame_samples
            count = (min(chunk, len(audio) - start) + frame_samples - 1) // frame_samples
            parts.append(scores[first : first + count])
    return torch.cat(parts), frame_samples / rate


def _character_tokens(word: str, context: str = "") -> list[list[int]]:
    """The alphabet indices each character of ``word`` is pronounced with (none for marks such as ь or punctuation)."""
    dictionary = MMS_FA.get_dict(star=None)
    characters = list(word)
    number = re.fullmatch(r"(\d+)(\W*)", word)
    if number:
        text = context.casefold()
        locale = next(
            (
                key
                for key, present in {
                    "uk": any(char in "іїєґ" for char in text),
                    "ru": any("а" <= char <= "я" or char == "ё" for char in text),
                }.items()
                if present
            ),
            "en",
        )
        try:
            spoken = num2words(int(number[1]), lang=locale)
            boundaries = np.linspace(0, len(spoken), len(number[1]) + 1, dtype=int)
            characters = [spoken[first:last] for first, last in zip(boundaries, boundaries[1:])]
            characters.extend(number[2])
        except (OverflowError, ValueError):
            pass
    result: list[list[int]] = []
    for character in characters:
        romanized = _NON_LETTERS.sub("", _romanizer().romanize_string(character, lang=None).lower())
        result.append([dictionary[letter] for letter in romanized if letter in dictionary])
    return result


def _transcript_path(
    scores: torch.Tensor, tokens: list[int], *, bounded_end: bool = False
) -> torch.Tensor:
    # A CTC path needs a frame per token, separating blanks for repeats, and the optional tail.
    minimum = len(tokens) + (not bounded_end) + sum(a == b for a, b in zip(tokens, tokens[1:]))
    if scores.shape[0] < minimum:
        raise ValueError("The vocal track is too short for the lyrics")
    # MMS's zero-score wildcard absorbs untranscribed audio after the lyrics. Without it, a
    # slightly better final-letter spike in an instrumental outro can win over the sung letter.
    star = scores.shape[-1]
    if not bounded_end:
        scores = torch.cat((scores, scores.new_zeros((scores.shape[0], 1))), dim=-1)
        tokens = [*tokens, star]
    aligned: torch.Tensor
    aligned, _ = forced_align(scores[None], torch.tensor([tokens], dtype=torch.int32), blank=0)
    return aligned.masked_fill(aligned == star, 0)


def align_words(
    scores: torch.Tensor,
    frame_seconds: float,
    words: Sequence[str],
    offset_seconds: float = 0.0,
    *,
    bounded_end: bool = False,
) -> list[AlignedWord]:
    """Times every word and letter of ``words`` (the text of one stretch, in order) against the emission of that stretch."""
    # Preserve the displayed digits, but give CTC their spoken sounds rather than
    # treating a sung number as punctuation with no pronunciation or timestamp.
    text = " ".join(words)
    per_word = [_character_tokens(word, text) for word in words]
    flat = [token for characters in per_word for tokens in characters for token in tokens]
    if not flat:
        return _placed([None] * len(words), words)
    aligned = _transcript_path(scores, flat, bounded_end=bounded_end)
    spans = merge_tokens(aligned[0], torch.exp(scores[torch.arange(scores.shape[0]), aligned[0]]))
    found: list[AlignedWord | None] = []
    position = 0
    for word, characters in zip(words, per_word, strict=True):
        if not any(characters):
            found.append(None)
            continue
        letters: list[float | None] = []
        first_token = position
        for tokens in characters:
            letters.append(
                spans[position].start * frame_seconds + offset_seconds if tokens else None
            )
            position += len(tokens)
        end = spans[position - 1].end * frame_seconds + offset_seconds
        start = next(moment for moment in letters if moment is not None)
        confidence = float(np.mean([span.score for span in spans[first_token:position]]))
        filled = _filled_letters(spread_tied_moments(letters, float(end)), float(end))
        found.append(AlignedWord(word, float(start), float(end), filled, confidence))
    return _placed(found, words)


def _clamped_letters(
    letters: Sequence[float], shift: float, start: float, end: float, *, text: str = ""
) -> tuple[float, ...]:
    """Shifts every letter by ``shift`` and clamps it to ``[start, end]``, then spreads away any run a
    shared boundary collapsed onto the same instant. Clamping each letter independently, without this,
    would leave a whole run of a word's opening letters flashing by together (see spread_tied_moments).
    """
    # Filled silent characters share the next sound's anchor; they are not extra
    # phonetic events and must not push that sound later when ties are spread.
    clamped: list[float | None] = [
        None
        if index < len(text) and (not text[index].isalnum() or text[index].casefold() in "ьъ")
        else min(max(moment + shift, start), end)
        for index, moment in enumerate(letters)
    ]
    return _filled_letters(spread_tied_moments(clamped, end), end)


def _filled_letters(letters: list[float | None], end: float) -> tuple[float, ...]:
    """A character without its own sound (ь, a comma) starts together with the next one."""
    filled = [
        moment
        if moment is not None
        else next((later for later in letters[index + 1 :] if later is not None), end)
        for index, moment in enumerate(letters)
    ]
    return tuple(round(moment, 3) for moment in filled)


def _placed(found: list[AlignedWord | None], words: Sequence[str]) -> list[AlignedWord]:
    """Words with nothing to pronounce (a lone dash) sit between their neighbours."""
    result: list[AlignedWord] = []
    for index, item in enumerate(found):
        if item is not None:
            result.append(item)
            continue
        before = result[-1].end if result else 0.0
        after = next((later.start for later in found[index + 1 :] if later is not None), before)
        moment = min(before, after)
        end = max(after, moment + _MINIMUM_WORD_SECONDS)
        result.append(AlignedWord(words[index], moment, end, (moment,) * len(words[index])))
    return result


def with_sung_ends(
    words: list[AlignedWord],
    samples: np.ndarray,
    instrumental: np.ndarray | None = None,
    voiced: np.ndarray | None = None,
    harmonics: tuple[np.ndarray, np.ndarray] | None = None,
    audible: np.ndarray | None = None,
    periodicity: np.ndarray | None = None,
) -> list[AlignedWord]:
    """Extend phonetic cores through singing, stopping at silence or the next word."""
    if voiced is None:
        voiced = singing_frames(samples, instrumental, _VOICE_RATE, _VOICE_HOP)
    if harmonics is None and instrumental is not None:
        harmonics = harmonic_evidence(samples, _VOICE_RATE, _VOICE_HOP)
    if periodicity is None:
        periodicity = (harmonics or harmonic_evidence(samples, _VOICE_RATE, _VOICE_HOP))[1]
    step = _VOICE_HOP / _VOICE_RATE
    continuation = _sung_continuation(samples, voiced, audible, periodicity)
    periodic = _bridged(periodicity >= 0.5, round(_BRIDGED_GAP_SECONDS / step))
    result: list[AlignedWord] = []
    for index, word in enumerate(words):
        limit = words[index + 1].start if index + 1 < len(words) else len(voiced) * step
        continued = continued_frames(voiced, harmonics, (word.start, word.end, limit), step)
        end = _sung_end(word, continued, continuation, periodicity, periodic, limit)
        silence = _first_long_silence(continued, word.start, end, step)
        letters = word.letters
        if silence is not None:
            end = max(silence, word.start + 0.001)
            letters = _clamped_letters(word.letters, 0.0, word.start, end, text=word.text)
        flags = dict.fromkeys(word.diagnostics)
        if letters != word.letters:
            flags.update(ApproximateLetterTiming=None, LetterTimingReviewRequired=None)
        end = round(max(end, word.start + 0.001), 3)
        result.append(replace(word, end=end, letters=letters, diagnostics=tuple(flags)))
    return result


def _sung_continuation(
    samples: np.ndarray, voiced: np.ndarray, audible: np.ndarray | None, periodicity: np.ndarray
) -> np.ndarray:
    # Phrase activity bridges consonant closures. After a confirmed phonetic core,
    # a real release must not bridge into a later breath, echo, or new entry.
    continuation = _bridged(
        audible_frames(samples, _VOICE_HOP) if audible is None else audible,
        round(_SILENT_START_SECONDS * _VOICE_RATE / _VOICE_HOP) - 1,
    )
    for first, last in _runs(continuation, False):
        if not (
            0 < first < last < len(continuation)
            and voiced[first:last].all()
            and float(np.median(periodicity[first:last])) >= 0.5
        ):
            continue
        # A quiet vowel can survive the loudness threshold. Short windows follow
        # melismas, strictly inside the dip so adjacent sounds cannot fill silence.
        gap = samples[first * _VOICE_HOP : last * _VOICE_HOP]
        frames = np.lib.stride_tricks.sliding_window_view(gap, 4 * _VOICE_HOP)[::_VOICE_HOP]
        spectrum = np.fft.rfft(frames - frames.mean(axis=1, keepdims=True), n=8 * _VOICE_HOP)
        correlation = np.fft.irfft(np.abs(spectrum) ** 2, n=8 * _VOICE_HOP)
        support = correlation[:, round(_VOICE_RATE / 1100) : round(_VOICE_RATE / 65)].max(axis=1)
        support /= np.maximum(correlation[:, 0], 1e-12)
        if float(np.median(support)) >= 0.5:
            continuation[first:last] = True
    return continuation


def _voiced_release(word: AlignedWord, periodicity: np.ndarray, step: float) -> bool:
    ending = next((char.casefold() for char in reversed(word.text) if char.isalpha()), "")
    core = periodicity[
        round(max(word.start, word.end - _SILENT_START_SECONDS) / step) : round(word.end / step)
    ]
    return (
        bool(ending)
        and ending in "aeiouyаеёиоуыэюяіїєймнлрmnrl"
        and len(core) >= round(_SILENT_START_SECONDS / step)
        and bool((core >= 0.5).all())
    )


def _sung_end(
    word: AlignedWord,
    continued: np.ndarray,
    continuation: np.ndarray,
    periodicity: np.ndarray,
    periodic: np.ndarray,
    limit: float,
) -> float:
    step = _VOICE_HOP / _VOICE_RATE
    last_letter = max(
        (
            moment
            for char, moment in zip(word.text, word.letters)
            if char.isalnum() and char.casefold() not in "ьъ"
        ),
        default=word.start,
    )
    # Onset calibration may shift a letter into the preceding vowel. Only
    # the ending sound can establish release; preserve quiet final fricatives
    # and stop closures whose earlier vowel would bias a whole-letter median.
    terminal = max(last_letter, word.end - _SILENT_START_SECONDS)
    core = periodicity[round(terminal / step) : round(word.end / step)]
    periodic_core = bool(len(core)) and float(np.median(core)) >= 0.5
    # A periodic vowel or sonorant can release straight into a breath without
    # an amplitude gap. Phrase activity alone cannot authorize that new noise.
    # Keep brief pitch dropouts, and never shorten the confirmed phonetic core.
    voiced_ending = periodic_core and _voiced_release(word, periodicity, step)
    frame = min(int(word.end / step), len(continued) - 1)
    while (
        frame + 1 < min(len(continued), len(continuation))
        and continued[frame]
        and (not periodic_core or continuation[frame])
        and (not voiced_ending or periodic[frame])
        and frame * step < limit
    ):
        frame += 1
    return max(word.end, min(frame * step, limit))


def with_sung_letters(
    words: list[AlignedWord],
    scores: torch.Tensor,
    frame_seconds: float,
    activity: np.ndarray,
    heard: Mapping[int, tuple[float, float]],
) -> list[AlignedWord]:
    """Recheck sung suffixes inside confirmed bounds; preserve word times and supported letters."""
    result = list(words)
    for index, word in enumerate(words):
        if (review := _collapsed_letter_review(word, scores, frame_seconds, activity)) is not None:
            result[index] = review
            continue
        following = words[index + 1] if index + 1 < len(words) else None
        last = _sung_tail_index(word)
        if last is None or not _sung_tail_supported(
            word, last, following, heard.get(index), activity, frame_seconds
        ):
            continue
        begin, end = max(0, int(word.start / frame_seconds)), round(word.end / frame_seconds)
        crop = scores[begin:end]
        try:
            original = align_words(crop, frame_seconds, [word.text], begin * frame_seconds)[0]
            candidate = align_words(
                crop, frame_seconds, [word.text], begin * frame_seconds, bounded_end=True
            )[0]
        except ValueError:
            result[index] = replace(
                word, diagnostics=(*word.diagnostics, "SungLetterAlignmentUnresolved")
            )
            continue
        letters = _sung_letter_candidate(word, original, candidate, last, scores, frame_seconds)
        if letters is not None:
            result[index] = replace(
                word, letters=letters, diagnostics=(*word.diagnostics, "SungConsonantRetimed")
            )
        elif _sung_letters_disagree(word, original, candidate, frame_seconds):
            flags = (*word.diagnostics, "LetterTimingReviewRequired", "ApproximateLetterTiming")
            result[index] = replace(word, diagnostics=tuple(dict.fromkeys(flags)))
    return result


def _collapsed_letter_review(
    word: AlignedWord, scores: torch.Tensor, step: float, activity: np.ndarray
) -> AlignedWord | None:
    """A clipped phonetic suffix is approximate even when a bounded CTC estimate is available."""
    first = next(
        (
            i
            for i, (char, moment) in enumerate(zip(word.text, word.letters))
            if char.isalnum() and char.casefold() not in "ьъ" and moment >= word.end
        ),
        None,
    )
    if first is None:
        return None
    flags = (*word.diagnostics, "LetterTimingReviewRequired", "ApproximateLetterTiming")
    word = replace(word, diagnostics=tuple(dict.fromkeys(flags)))
    voice_step = _VOICE_HOP / _VOICE_RATE
    stop = round(word.end / voice_step)
    needed = round(_SILENCE_ENDS_WORD_SECONDS / voice_step)
    pause = activity[stop : stop + needed]
    # A conflicting neighbour is not an acoustic endpoint. Keep it unresolved;
    # this path only estimates letters inside a word stopped by a real pause.
    if (
        first == 0
        or word.score <= 0
        or len(word.letters) != len(word.text)
        or len(pause) != needed
        or pause.any()
    ):
        return word
    return _bounded_letter_estimate(word, scores, step, first)


def _bounded_letter_estimate(
    word: AlignedWord, scores: torch.Tensor, step: float, first: int
) -> AlignedWord:
    """Keep intact anchors and word bounds; the replacement suffix remains approximate."""
    begin, stop = max(0, int(word.start / step)), round(word.end / step)
    try:
        candidate = align_words(
            scores[begin:stop], step, [word.text], begin * step, bounded_end=True
        )[0]
    except ValueError:
        return word
    shift = word.letters[0] - candidate.letters[0]
    if candidate.score <= 0 or any(
        abs(saved - (moment + shift)) > step + 1e-9
        for saved, moment in zip(word.letters[:first], candidate.letters[:first], strict=True)
    ):
        return word
    letters = (
        *word.letters[:first],
        *(round(moment + shift, 3) for moment in candidate.letters[first:]),
    )
    if (
        letters[0] < word.start
        or letters[-1] > word.end
        or any(a > b for a, b in zip(letters, letters[1:]))
        or any(
            char.isalnum() and char.casefold() not in "ьъ" and start >= end
            for char, start, end in zip(
                word.text[first:], letters[first:], (*letters[first + 1 :], word.end), strict=True
            )
        )
    ):
        return word
    return replace(word, letters=letters, score=min(word.score, candidate.score))


def _sung_letters_disagree(
    word: AlignedWord, original: AlignedWord, candidate: AlignedWord, step: float
) -> bool:
    if not max(original.score, candidate.score) >= word.score:
        return False
    shift = word.letters[0] - original.letters[0]
    return any(
        char.isalpha() and char.casefold() not in "ьъ" and abs(moment + shift - saved) > step + 1e-9
        for aligned in (original, candidate)
        for char, moment, saved in zip(word.text, aligned.letters, word.letters, strict=True)
    )


def _sung_tail_index(word: AlignedWord) -> int | None:
    if word.score <= 0 or len(word.letters) != len(word.text):
        return None
    pronounced = [
        i for i, char in enumerate(word.text) if char.isalpha() and char.casefold() not in "ьъ"
    ]
    last = pronounced[-1] if pronounced else -1
    if (
        last < 1
        or word.text[last].casefold() in "aeiouyаеёиоуыэюяіїє"
        or word.end - word.letters[last] <= _HEARD_DISAGREEMENT_SECONDS
    ):
        return None
    return last


def _sung_tail_supported(
    word: AlignedWord,
    last: int,
    following: AlignedWord | None,
    heard: tuple[float, float] | None,
    activity: np.ndarray,
    step: float,
) -> bool:
    bounded = (
        heard is not None
        and heard[0] - _HEARD_DISAGREEMENT_SECONDS <= word.start < heard[1]
        and abs(heard[1] - word.end) <= _HEARD_DISAGREEMENT_SECONDS
    ) or (
        following is not None
        and following.score > _PREFERENCE
        and "BoundaryConflict" not in following.diagnostics
        and abs(following.start - word.end) <= step
    )
    voice_step = _VOICE_HOP / _VOICE_RATE
    first, stop = int(word.letters[last] / voice_step), round(word.end / voice_step)
    return bounded and 0 <= first < stop <= len(activity) and bool(activity[first:stop].all())


def _sung_letter_candidate(
    word: AlignedWord,
    original: AlignedWord,
    candidate: AlignedWord,
    last: int,
    scores: torch.Tensor,
    step: float,
) -> tuple[float, ...] | None:
    shift = word.letters[0] - original.letters[0]
    if candidate.score < max(word.score, original.score) or any(
        abs(a - b) > step
        for a, b in zip(candidate.letters[:last], original.letters[:last], strict=True)
    ):
        return None
    characters = _character_tokens(word.text)
    tokens = characters[last]
    if not tokens:
        return None
    previous = original.letters[last]
    if (
        len(tokens) == 1
        and abs(previous - candidate.letters[last]) <= step
        and abs(previous + shift - word.letters[last]) > step + 1e-9
    ):
        previous = word.letters[last] - shift
    if not 0 <= round(previous / step) < len(scores):
        return None
    support = [
        float(scores[round(moment / step), tokens[0]].exp())
        for moment in (previous, candidate.letters[last])
    ]
    if support[1] <= support[0] + _PREFERENCE:
        return None
    return _sung_letter_times(word, candidate, last, characters, scores, step, shift)


def _sung_letter_times(
    word: AlignedWord,
    candidate: AlignedWord,
    last: int,
    characters: list[list[int]],
    scores: torch.Tensor,
    step: float,
    shift: float,
) -> tuple[float, ...] | None:
    prefix = list(word.letters[:last])
    for index, saved in enumerate(prefix):
        proposed = candidate.letters[index] + shift
        if abs(proposed - saved) <= step + 1e-9:
            continue
        # A romanized multi-token grapheme has no single posterior that can
        # certify its whole movement. Keep it pending rather than guess a split.
        if len(characters[index]) != 1:
            return None
        before, after = round((saved - shift) / step), round(candidate.letters[index] / step)
        if not 0 <= before < len(scores):
            return None
        token = characters[index][0]
        if float(scores[after, token].exp()) <= float(scores[before, token].exp()) + _PREFERENCE:
            return None
        prefix[index] = round(proposed, 3)
    tail = _clamped_letters(
        candidate.letters[last:], shift, prefix[-1], word.end, text=word.text[last:]
    )
    if tail[0] <= word.letters[last] + step or tail[0] >= word.end:
        return None
    result = (*prefix, *tail)
    if (
        result[0] < word.start
        or result[-1] > word.end
        or any(a > b for a, b in zip(result, result[1:]))
    ):
        return None
    return result


def _first_long_silence(voiced: np.ndarray, start: float, end: float, step: float) -> float | None:
    """Where the first pause of at least _SILENCE_ENDS_WORD_SECONDS after the word's sound begins starts."""
    first, last = int(start / step), min(len(voiced), int(end / step))
    sounding = np.flatnonzero(voiced[first:last])
    if not len(sounding):
        return None
    needed = round(_SILENCE_ENDS_WORD_SECONDS / step)
    run = 0
    for frame in range(first + int(sounding[0]), last):
        run = 0 if voiced[frame] else run + 1
        if run >= needed:
            return (frame - run + 1) * step
    return None


def with_voice_onsets(
    words: list[AlignedWord], samples: np.ndarray, voiced: np.ndarray | None = None
) -> list[AlignedWord]:
    """Calibrate from measured voice entries; keep uncalibrated starts explicitly uncertain."""
    if voiced is None:
        voiced = voiced_frames(samples, _VOICE_RATE, _VOICE_HOP)
    step = _VOICE_HOP / _VOICE_RATE
    found = _voice_entries(words, voiced, step)
    if not found and len(samples):
        found = _voice_entries(words, voiced, step, vocal_onsets(samples, _VOICE_RATE, _VOICE_HOP))
    lags = [words[index].start - onset for index, onset in found.items()]
    lag = min(_LARGEST_LAG_SECONDS, max(0.0, float(np.median(lags)))) if lags else 0.0
    result: list[AlignedWord] = []
    floor = 0.0
    for index, word in enumerate(words):
        if index in found:
            lag = min(_LARGEST_LAG_SECONDS, max(0.0, word.start - found[index]))
        # A locally recovered entry supplies its own anchor. Calibrate it only from
        # a nearby acoustic entry, never from the unrelated first word's lag.
        start = (
            word.start
            if "OnsetRecovered" in word.diagnostics and index not in found
            else found.get(index, word.start - lag)
        )
        start = max(min(start, word.end - 0.001), floor)
        shift = start - word.start
        end = max(word.end, start + 0.001)
        letters = _clamped_letters(word.letters, shift, start, end, text=word.text)
        diagnostics = word.diagnostics
        if not found and "OnsetRecovered" not in diagnostics:
            diagnostics = tuple(dict.fromkeys((*diagnostics, "OnsetReviewRequired")))
        result.append(
            replace(word, start=round(start, 3), end=end, letters=letters, diagnostics=diagnostics)
        )
        floor = start
    return result


def _voice_entries(
    words: Sequence[AlignedWord], voiced: np.ndarray, step: float, onsets: np.ndarray | None = None
) -> dict[int, float]:
    """Find local voice entries without dropping quieter recognized initial consonants."""
    if onsets is None:
        onsets = (np.flatnonzero(voiced[1:] & ~voiced[:-1]) + 1) * step
    found: dict[int, float] = {}
    for index, word in enumerate(words):
        after_pause = index == 0 or word.start - words[index - 1].end >= _PAUSE_SECONDS
        nearby = onsets[
            (onsets >= word.start - _ONSET_SEARCH_BEFORE_SECONDS)
            & (onsets <= word.start + _ONSET_SEARCH_AFTER_SECONDS)
        ]
        if not after_pause:
            # The acoustic pause can be clear even when the preceding CTC core ends late.
            nearby = nearby[nearby >= words[index - 1].end]
        if len(nearby):
            onset = float(nearby[np.argmin(np.abs(nearby - word.start))])
            # A quiet initial consonant can precede the louder vowel or nasal entry.
            found[index] = min(word.start, onset)
    return found


@dataclass(frozen=True, slots=True)
class Window:
    """Words ``first`` up to ``last`` (exclusive) are sung between the times ``start`` and ``end`` (seconds)."""

    first: int
    last: int
    start: float
    end: float
    heard_start: float | None = None


def _align_window(
    scores: torch.Tensor,
    frame_seconds: float,
    chunk: Sequence[str],
    window: Window,
    *,
    recovery_bounds: tuple[float, float] | None = None,
) -> list[AlignedWord]:
    """Retry a failed crop only within caller-supplied neighbouring acoustic anchors."""
    begin = max(0, int(window.start / frame_seconds))
    stop = min(scores.shape[0], max(begin + 1, int(window.end / frame_seconds)))
    attempts = [(begin, stop)]
    if recovery_bounds is not None:
        first, last = recovery_bounds
        expanded = (
            max(0, ceil(max(first, window.start - _CONTEXT_SECONDS) / frame_seconds)),
            min(
                scores.shape[0],
                int(min(last, window.end + _CONTEXT_SECONDS) / frame_seconds),
            ),
        )
        if expanded[0] < expanded[1] and expanded != attempts[0]:
            attempts.append(expanded)
    for begin, stop in attempts:
        try:
            return align_words(scores[begin:stop], frame_seconds, chunk, begin * frame_seconds)
        except ValueError:
            continue
    return _evenly(
        chunk, window.start, max(window.end, window.start + _MINIMUM_WORD_SECONDS * len(chunk))
    )


def _confidence(words: Sequence[AlignedWord]) -> float:
    scored = [word.score for word in words if word.score > 0]
    return float(np.mean(scored)) if scored else 0.0


def align_guided(
    scores: torch.Tensor,
    frame_seconds: float,
    words: Sequence[str],
    windows: Sequence[Window],
    heard: Mapping[int, float] = MappingProxyType({}),
    voiced: np.ndarray | None = None,
    whole: Sequence[AlignedWord] | None = None,
    *,
    anchors: Mapping[int, float] = MappingProxyType({}),
) -> list[AlignedWord]:
    """Choose guided or whole-song timing using recognition and voiced activity."""
    whole = align_words(scores, frame_seconds, words) if whole is None else whole
    result: list[AlignedWord] = []
    for window in windows:
        chunk = list(words[window.first : window.last])
        if not chunk:
            continue
        entry, following = anchors.get(window.first), heard.get(window.last)
        start = (
            min(window.start, max(0.0, entry - _HEARD_DISAGREEMENT_SECONDS))
            if entry is not None
            else window.start
        )
        window = replace(
            window,
            start=start,
            end=min(window.end, following + _HEARD_DISAGREEMENT_SECONDS)
            if following is not None and following > start
            else window.end,
        )
        reference = list(whole[window.first : window.last])
        if voiced is not None and window.heard_start is not None:
            step = _VOICE_HOP / _VOICE_RATE
            pause = _first_long_silence(voiced, reference[0].start, reference[0].end, step)
            if pause is not None and pause <= window.heard_start:
                first = round(pause / step)
                sounding = np.flatnonzero(voiced[first : round(reference[0].end / step)])
                entry = float((first + sounding[0]) * step) if len(sounding) else pause
                if window.heard_start - _ONSET_SEARCH_BEFORE_SECONDS <= entry < window.end:
                    # Refit at returning voice even when coarse recognition trails it.
                    window = replace(window, start=max(window.start, entry))
        recovery_end = (
            following
            if following is not None
            else whole[window.last].start
            if window.last < len(whole)
            else max(window.end, reference[-1].end) + _CONTEXT_SECONDS
        )
        guided = _align_window(
            scores,
            frame_seconds,
            chunk,
            window,
            recovery_bounds=(result[-1].end if result else 0.0, recovery_end),
        )
        sequential = [
            candidate
            for candidate in (guided, reference)
            if (not result or candidate[0].start > result[-1].start + 1e-9)
            # A separate crop can reuse the preceding word's suffix. Its higher
            # mean score cannot erase supported anchors, but weak forced paths may be replaced.
            and (
                not result
                or result[-1].score <= _PREFERENCE
                or not _clips_letter_anchor(result[-1], candidate[0].start)
            )
            and (
                not result
                or voiced is None
                or _implausible([ordered([result[-1], candidate[0]])[0]], voiced)
                <= _implausible([result[-1]], voiced)
            )
            and (
                window.last == len(whole)
                or following is not None
                # A next word from an earlier repeat cannot veto this phrase
                # before its own window gets a chance to recover it.
                or whole[window.last].start <= reference[-1].start
                or candidate[-1].start < whole[window.last].start
            )
        ]
        candidates = [
            candidate
            for candidate in sequential
            if (
                entry is None
                or window.start - _HEARD_DISAGREEMENT_SECONDS
                <= candidate[0].start
                <= candidate[-1].start
                < window.end
            )
        ] or sequential
        if not candidates:
            return ordered(list(whole))
        result.extend(
            candidates[0]
            if len(candidates) == 1
            else _preferred(guided, reference, window.first, heard, voiced)
        )
    return ordered(result)


def _preferred(
    guided: list[AlignedWord],
    reference: list[AlignedWord],
    first: int,
    heard: Mapping[int, float],
    voiced: np.ndarray | None,
) -> list[AlignedWord]:
    # Unchanged words supply no evidence for either placement. Compare the disputed
    # boundaries so one bad word is not hidden by the rest of a correctly timed phrase.
    changed = [
        index
        for index, (left, right) in enumerate(zip(guided, reference, strict=True))
        if max(abs(left.start - right.start), abs(left.end - right.end))
        > _HEARD_DISAGREEMENT_SECONDS
    ]
    local_heard = (
        {first + index: heard[first + index] for index in changed if first + index in heard}
        if changed
        else heard
    )
    guided_miss = _heard_distance(guided, first, local_heard)
    reference_miss = _heard_distance(reference, first, local_heard)
    if (
        guided_miss is not None
        and reference_miss is not None
        and abs(guided_miss - reference_miss) > _HEARD_DISAGREEMENT_SECONDS
    ):
        closer, other = (guided, reference) if guided_miss < reference_miss else (reference, guided)
        if voiced is None or _implausible(closer, voiced) <= _implausible(other, voiced):
            return closer
    left = [guided[index] for index in changed] if changed else guided
    right = [reference[index] for index in changed] if changed else reference
    # Compare relative likelihood: an absolute probability margin suppresses all
    # improvements in weak phonetic cores, even when the guided placement is twice as likely.
    return guided if _confidence(left) > _confidence(right) * (1 + _PREFERENCE) else reference


def _heard_distance(
    words: Sequence[AlignedWord], first: int, heard: Mapping[int, float]
) -> float | None:
    distances = [
        abs(word.start - heard[first + index])
        for index, word in enumerate(words)
        if first + index in heard
    ]
    return float(np.median(distances)) if distances else None


def _implausible(words: Sequence[AlignedWord], voiced: np.ndarray) -> int:
    """Words that start where nothing is sung, or that are crushed too short to be a sung word."""
    step = _VOICE_HOP / _VOICE_RATE
    lead = round(_SILENT_START_SECONDS / step)
    count = 0
    for word in words:
        frame = int(word.start / step)
        if frame < len(voiced) and not voiced[frame : frame + lead].any():
            count += 1
        if (
            word.end - word.start + 1e-9 < _CRAMMED_WORD_SECONDS
            and sum(c.isalnum() for c in word.text) >= 2
        ):
            count += 1
    return count


def _evenly(words: Sequence[str], start: float, end: float) -> list[AlignedWord]:
    weights = np.array([max(len(word), 1) for word in words], dtype=np.float64)
    edges = start + np.concatenate(([0.0], np.cumsum(weights) / weights.sum())) * (end - start)
    result: list[AlignedWord] = []
    for i, word in enumerate(words):
        word_start, word_end = float(edges[i]), float(edges[i + 1])
        count = max(len(word), 1)
        # A window too short for a word's own character count would otherwise round several of its
        # letters to the same displayed millisecond even though this split is nominally even; spreading
        # settles that the same way a same-frame CTC tie is settled elsewhere.
        raw: list[float | None] = [
            word_start + (word_end - word_start) * k / count for k in range(len(word))
        ]
        letters = tuple(
            round(moment, 3) for moment in spread_tied_moments(raw, word_end) if moment is not None
        )
        result.append(
            AlignedWord(
                word, word_start, word_end, letters, diagnostics=("ApproximateLetterTiming",)
            )
        )
    return result


def _tied_sounding_letters(text: str, letters: Sequence[float]) -> bool:
    sounding = [
        moment
        for char, moment in zip(text, letters)
        if char.isalnum() and char.casefold() not in "ьъ"
    ]
    return any(left == right for left, right in zip(sounding, sounding[1:]))


def _ordered_letters(word: AlignedWord, start: float, end: float) -> tuple[float, ...]:
    # Preserve bounded anchors after rounding; repeat spreading only after a new
    # clamp, or for unresolved sounding ties that have not yet been estimated.
    if any(moment < start or moment > end for moment in word.letters) or (
        "ApproximateLetterTiming" not in word.diagnostics
        and _tied_sounding_letters(word.text, word.letters)
    ):
        return _clamped_letters(word.letters, 0.0, start, end, text=word.text)
    return tuple(round(moment, 3) for moment in word.letters)


def ordered(words: list[AlignedWord]) -> list[AlignedWord]:
    """Settle overlaps without letting unsupported starts clip cores or propagate into later words."""
    starts: list[float] = []
    cursor = 0.0
    for word in words:
        start = max(round(word.start, 3), cursor)
        starts.append(start)
        # Reserve only one serialized millisecond; real fast words need no 50-ms speech minimum.
        cursor = round(start + 0.001, 3)
    for index in range(1, len(words)):
        previous, word = words[index - 1 : index + 1]
        end = round(previous.end, 3)
        limit = min(round(word.end, 3), starts[index + 1] if index + 1 < len(words) else word.end)
        # A proportional fallback has no acoustic start to justify cutting its
        # supported neighbour. Use only its own available span; never push the
        # conflict into a later word. Competing supported cores still need review.
        if previous.score > 0 and word.score <= 0 and starts[index] < end < limit:
            starts[index] = end
    result: list[AlignedWord] = []
    for index, word in enumerate(words):
        start = starts[index]
        end = max(round(word.end, 3), round(start + 0.001, 3))
        if index + 1 < len(starts):
            end = min(end, starts[index + 1])
        letters = _ordered_letters(word, start, end)
        result.append(
            replace(
                word,
                start=round(start, 3),
                end=round(end, 3),
                letters=letters,
                diagnostics=_ordering_diagnostics(word, start, end, letters),
            )
        )
    return result


def _clips_letter_anchor(word: AlignedWord, end: float) -> bool:
    """A sounding anchor on the new end loses its positive interval too."""
    return any(
        end - 1e-9 <= moment < word.end - 1e-9
        for char, moment in zip(word.text, word.letters)
        if char.isalnum() and char.casefold() not in "ьъ"
    )


def _ordering_diagnostics(
    word: AlignedWord, start: float, end: float, letters: tuple[float, ...]
) -> tuple[str, ...]:
    clipped = word.end - end > _VOICE_HOP / _VOICE_RATE + 1e-9
    conflict = (
        start > word.start + 0.001
        or word.end - end > _HEARD_DISAGREEMENT_SECONDS
        or clipped
        and (end - start <= (word.end - word.start) / 2 + 1e-9 or _clips_letter_anchor(word, end))
        or word.end - word.start >= _CRAMMED_WORD_SECONDS
        and end - start + 1e-9 < _CRAMMED_WORD_SECONDS
    )
    return tuple(
        dict.fromkeys(
            (
                *word.diagnostics,
                *(("BoundaryClipped",) if clipped else ()),
                *(("BoundaryConflict",) if conflict else ()),
                *(
                    ("ApproximateLetterTiming", "LetterTimingReviewRequired")
                    if letters != tuple(round(moment, 3) for moment in word.letters)
                    or _tied_sounding_letters(word.text, letters)
                    else ()
                ),
            )
        )
    )
