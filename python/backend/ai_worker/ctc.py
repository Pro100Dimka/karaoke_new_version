from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache

import numpy as np
import torch
import torchaudio
import uroman
from torchaudio.functional import forced_align, merge_tokens
from torchaudio.pipelines import MMS_FA

from backend.ai.catalog import ALIGNMENT_MODEL
from backend.ai_worker.paths import model_file
from backend.ai_worker.runtime import device
from backend.ai_worker.timing import voiced_frames
from backend.moment_spreading import spread_tied_moments

_CHUNK_SECONDS = 20.0
_CONTEXT_SECONDS = 2.0
_MINIMUM_WORD_SECONDS = 0.05
_LONGEST_HOLD_SECONDS = 6.0
# A genuinely held note rarely needs more than this per character; a word far past it is more likely a
# guided window that swallowed audio belonging to unrecognised neighbouring words (common for melismatic
# runs and ad-libs Whisper could not transcribe) than one real sustained pronunciation.
_MAX_SECONDS_PER_CHARACTER = 2.0
_PREFERENCE = 0.05
_PAUSE_SECONDS = 0.25
# The model marks a letter only "a little" after its sound begins (see with_voice_onsets below); a wider
# window than this risks locking onto a nearer but unrelated voiced region -- a breath, backing vocal, or
# the previous word's tail -- and moving a word by far more than any such lag ever really is.
_ONSET_SEARCH_BEFORE_SECONDS = 0.25
_ONSET_SEARCH_AFTER_SECONDS = 0.1
_LARGEST_LAG_SECONDS = 0.3
_DEFAULT_LAG_SECONDS = 0.1
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


@lru_cache(maxsize=1)
def _romanizer() -> uroman.Uroman:
    return uroman.Uroman()


@lru_cache(maxsize=1)
def _model() -> torch.nn.Module:
    """The multilingual character-level CTC model of Meta's MMS forced aligner, loaded from the verified download."""
    model: torch.nn.Module = torchaudio.models.wav2vec2_model(**MMS_FA._params)  # noqa: SLF001 - private bundle config
    weights = torch.load(model_file(ALIGNMENT_MODEL), map_location="cpu")
    # The checkpoint predicts 31 symbols; the pad, end and unknown markers (1..3) are not part of the alignment alphabet.
    keep = [0, *range(4, weights["aux.weight"].shape[0])]
    weights["aux.weight"], weights["aux.bias"] = (
        weights["aux.weight"][keep],
        weights["aux.bias"][keep],
    )
    model.load_state_dict(weights)
    return model.to(device()).eval()


def emission(samples: np.ndarray) -> tuple[torch.Tensor, float]:
    """Log-probabilities of the model's characters for every frame (16 kHz audio in), and the seconds one frame lasts.

    The song is read in overlapping chunks (the model's attention grows with the square of the length) and only the
    central part of each chunk is kept.
    """
    rate = MMS_FA.sample_rate
    audio = torch.from_numpy(samples)
    chunk, context = int(_CHUNK_SECONDS * rate), int(_CONTEXT_SECONDS * rate)
    parts: list[torch.Tensor] = []
    frame_samples = 0.0
    # The first and last chunk are shorter than the rest (no context before the song's start, and whatever
    # remainder is left at its end); the model's fixed-stride downsampling rounds their samples-per-frame
    # ratio off very slightly differently. A full middle chunk gives the most reliable ratio -- using
    # whichever chunk happened to run last instead would misconvert every frame index to a time that is
    # off by that chunk's own tiny rounding, and the error grows with the song's length.
    reference_frame_samples: float | None = None
    with torch.inference_mode():
        for start in range(0, len(audio), chunk):
            begin, end = max(0, start - context), min(len(audio), start + chunk + context)
            logits, _ = _model()(audio[begin:end][None].to(device()))
            scores = torch.log_softmax(logits, dim=-1)[0].cpu()
            frame_samples = (end - begin) / scores.shape[0]
            if end - begin == chunk + 2 * context:
                reference_frame_samples = frame_samples
            first = round((start - begin) / frame_samples)
            parts.append(
                scores[first : first + round(min(chunk, len(audio) - start) / frame_samples)]
            )
    return torch.cat(parts), (reference_frame_samples or frame_samples) / rate


def _character_tokens(word: str) -> list[list[int]]:
    """The alphabet indices each character of ``word`` is pronounced with (none for marks such as ь or punctuation)."""
    dictionary = MMS_FA.get_dict(star=None)
    result: list[list[int]] = []
    for character in word:
        romanized = _NON_LETTERS.sub("", _romanizer().romanize_string(character, lang=None).lower())
        result.append([dictionary[letter] for letter in romanized if letter in dictionary])
    return result


def align_words(
    scores: torch.Tensor, frame_seconds: float, words: Sequence[str], offset_seconds: float = 0.0
) -> list[AlignedWord]:
    """Times every word and letter of ``words`` (the text of one stretch, in order) against the emission of that stretch."""
    per_word = [_character_tokens(word) for word in words]
    flat = [token for characters in per_word for tokens in characters for token in tokens]
    if not flat:
        return _placed([None] * len(words), words)
    if scores.shape[0] < len(flat) * 2:
        raise ValueError("The vocal track is too short for the lyrics")
    aligned, _ = forced_align(scores[None], torch.tensor([flat], dtype=torch.int32), blank=0)
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
        found.append(
            AlignedWord(
                word,
                float(start),
                float(end),
                _filled_letters(spread_tied_moments(letters, float(end)), float(end)),
                confidence,
            )
        )
    return _placed(found, words)


def _clamped_letters(
    letters: Sequence[float], shift: float, start: float, end: float
) -> tuple[float, ...]:
    """Shifts every letter by ``shift`` and clamps it to ``[start, end]``, then spreads away any run a
    shared boundary collapsed onto the same instant. Clamping each letter independently, without this,
    would leave a whole run of a word's opening letters flashing by together (see spread_tied_moments).
    """
    clamped: list[float | None] = [min(max(moment + shift, start), end) for moment in letters]
    return tuple(
        round(moment, 3) for moment in spread_tied_moments(clamped, end) if moment is not None
    )


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
        result.append(
            AlignedWord(
                words[index],
                moment,
                max(after, moment + _MINIMUM_WORD_SECONDS),
                (moment,) * len(words[index]),
            )
        )
    return result


def with_sung_ends(words: list[AlignedWord], samples: np.ndarray) -> list[AlignedWord]:
    """Stretches each word to the end of the sound it starts.

    The model marks a letter by the instant it is recognised, so a held vowel looks short; the end of a word is where the
    voice really stops, at most where the next word begins and never more than a few seconds.
    """
    voiced = voiced_frames(samples, _VOICE_RATE, _VOICE_HOP)
    step = _VOICE_HOP / _VOICE_RATE
    result: list[AlignedWord] = []
    for index, word in enumerate(words):
        limit = min(
            words[index + 1].start if index + 1 < len(words) else len(voiced) * step,
            word.end + _LONGEST_HOLD_SECONDS,
        )
        frame = min(int(word.end / step), len(voiced) - 1)
        while frame + 1 < len(voiced) and voiced[frame] and (frame + 1) * step < limit:
            frame += 1
        end = max(word.end, min(frame * step, limit))
        result.append(
            AlignedWord(
                word.text,
                word.start,
                round(max(end, word.start + _MINIMUM_WORD_SECONDS), 3),
                word.letters,
            )
        )
    return result


def with_voice_onsets(words: list[AlignedWord], samples: np.ndarray) -> list[AlignedWord]:
    """Moves word starts back to where the voice really starts.

    The model marks a letter a little after its sound begins. A word that follows a pause starts at the voice onset found
    in the audio; the typical lag measured on those words is then removed from the words inside a phrase.
    """
    voiced = voiced_frames(samples, _VOICE_RATE, _VOICE_HOP)
    step = _VOICE_HOP / _VOICE_RATE
    onsets = np.flatnonzero(voiced[1:] & ~voiced[:-1]) + 1
    found: dict[int, float] = {}
    for index, word in enumerate(words):
        after_pause = index == 0 or word.start - words[index - 1].end >= _PAUSE_SECONDS
        nearby = onsets[
            (onsets * step >= word.start - _ONSET_SEARCH_BEFORE_SECONDS)
            & (onsets * step <= word.start + _ONSET_SEARCH_AFTER_SECONDS)
        ]
        if after_pause and len(nearby):
            found[index] = float(nearby[np.argmin(np.abs(nearby * step - word.start))]) * step
    lags = [words[index].start - onset for index, onset in found.items()]
    lag = (
        min(_LARGEST_LAG_SECONDS, max(0.0, float(np.median(lags))))
        if lags
        else _DEFAULT_LAG_SECONDS
    )
    result: list[AlignedWord] = []
    floor = 0.0
    for index, word in enumerate(words):
        start = found.get(index, word.start - lag)
        start = max(min(start, word.end - _MINIMUM_WORD_SECONDS), floor)
        shift = start - word.start
        end = max(word.end, start + _MINIMUM_WORD_SECONDS)
        letters = _clamped_letters(word.letters, shift, start, end)
        result.append(AlignedWord(word.text, round(start, 3), end, letters, word.score))
        floor = start
    return result


@dataclass(frozen=True, slots=True)
class Window:
    """Words ``first`` up to ``last`` (exclusive) are sung between the times ``start`` and ``end`` (seconds)."""

    first: int
    last: int
    start: float
    end: float


def _align_window(
    scores: torch.Tensor, frame_seconds: float, chunk: Sequence[str], window: Window
) -> list[AlignedWord]:
    begin = max(0, int(window.start / frame_seconds))
    stop = min(scores.shape[0], max(begin + 1, int(window.end / frame_seconds)))
    try:
        return align_words(scores[begin:stop], frame_seconds, chunk, begin * frame_seconds)
    except ValueError:
        return _evenly(
            chunk, window.start, max(window.end, window.start + _MINIMUM_WORD_SECONDS * len(chunk))
        )


def _confidence(words: Sequence[AlignedWord]) -> float:
    scored = [word.score for word in words if word.score > 0]
    return float(np.mean(scored)) if scored else 0.0


def align_guided(
    scores: torch.Tensor, frame_seconds: float, words: Sequence[str], windows: Sequence[Window]
) -> list[AlignedWord]:
    """Aligns the text against the whole song and, for each stretch with a known place, inside that part of the audio.

    Where the whole-song alignment is unsure (a noisy intro, a break) the guided one is usually right; where the hint is
    wrong (a repeated chorus matched to the wrong repeat) the whole-song one is. The placement the model finds more
    probable is kept, stretch by stretch. A window too short for its words shares its time among them evenly.
    """
    whole = align_words(scores, frame_seconds, words)
    result: list[AlignedWord] = []
    for window in windows:
        chunk = list(words[window.first : window.last])
        if not chunk:
            continue
        guided = _align_window(scores, frame_seconds, chunk, window)
        reference = whole[window.first : window.last]
        result.extend(
            guided if _confidence(guided) > _confidence(reference) + _PREFERENCE else reference
        )
    return ordered(result)


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
        result.append(
            AlignedWord(
                word,
                word_start,
                word_end,
                tuple(
                    round(moment, 3)
                    for moment in spread_tied_moments(raw, word_end)
                    if moment is not None
                ),
            )
        )
    return result


def _evenly_spread_letters(text: str, start: float, end: float) -> tuple[float, ...]:
    """One character's worth of the span each, in order -- the same even split _evenly() gives a whole
    window, used here for a single word whose raw per-letter positions are not trustworthy."""
    count = max(len(text), 1)
    step = (end - start) / count
    return tuple(round(start + step * index, 3) for index in range(count))


def ordered(words: list[AlignedWord]) -> list[AlignedWord]:
    """Words never go backwards and always last a little: overlaps of neighbouring windows and moved starts are settled here."""
    result: list[AlignedWord] = []
    cursor = 0.0
    for word in words:
        start = max(word.start, cursor)
        end = max(word.end, start + _MINIMUM_WORD_SECONDS)
        if end - start > _MAX_SECONDS_PER_CHARACTER * max(len(word.text), 1):
            # Trusting the raw letters here would show one of them dominating almost the whole word,
            # then snapping to complete right at the very end; spreading them evenly at least keeps the
            # fill visibly progressing, even though the word's own total duration is still whatever the
            # window guessed.
            letters = _evenly_spread_letters(word.text, start, end)
        else:
            letters = _clamped_letters(word.letters, 0.0, start, end)
        result.append(AlignedWord(word.text, round(start, 3), round(end, 3), letters))
        # The next word must not start before this one ends, or the two would overlap on screen -- this is the
        # actual overlap settlement the docstring promises; tracking only the start here would not enforce it.
        cursor = end
    return result
