from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from functools import lru_cache
from math import prod
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
from backend.ai_worker.timing import continued_frames, harmonic_evidence, singing_frames, voiced_frames
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
    # Match MMS_FA.get_model() preprocessing while retaining verified local checkpoint loading.
    model = _extend_model(model, normalize_waveform=MMS_FA._normalize_waveform)  # noqa: SLF001
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
    # Valid convolutions omit their final incomplete receptive field; input length / output count is
    # therefore not the frame stride. Using that ratio both drops frames at chunk seams and gradually
    # stretches the concatenated time axis. All chunks use the extractor's fixed sample stride.
    frame_samples = prod(
        stride for _, _, stride in MMS_FA._params["extractor_conv_layer_config"]  # noqa: SLF001
    )
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
        locale = next((key for key, present in {
            "uk": any(char in "іїєґ" for char in text),
            "ru": any("а" <= char <= "я" or char == "ё" for char in text),
        }.items() if present), "en")
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


def _transcript_path(scores: torch.Tensor, tokens: list[int]) -> torch.Tensor:
    # MMS's zero-score wildcard absorbs untranscribed audio after the lyrics. Without it, a
    # slightly better final-letter spike in an instrumental outro can win over the sung letter.
    star = scores.shape[-1]
    with_star = torch.cat((scores, scores.new_zeros((scores.shape[0], 1))), dim=-1)
    aligned: torch.Tensor
    aligned, _ = forced_align(
        with_star[None], torch.tensor([[*tokens, star]], dtype=torch.int32), blank=0
    )
    return aligned.masked_fill(aligned == star, 0)


def align_words(
    scores: torch.Tensor, frame_seconds: float, words: Sequence[str], offset_seconds: float = 0.0
) -> list[AlignedWord]:
    """Times every word and letter of ``words`` (the text of one stretch, in order) against the emission of that stretch."""
    # Preserve the displayed digits, but give CTC their spoken sounds rather than
    # treating a sung number as punctuation with no pronunciation or timestamp.
    text = " ".join(words)
    per_word = [_character_tokens(word, text) for word in words]
    flat = [token for characters in per_word for tokens in characters for token in tokens]
    if not flat:
        return _placed([None] * len(words), words)
    if scores.shape[0] < len(flat) * 2:
        raise ValueError("The vocal track is too short for the lyrics")
    aligned = _transcript_path(scores, flat)
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
        found.append(AlignedWord(
            word, float(start), float(end),
            _filled_letters(spread_tied_moments(letters, float(end)), float(end)), confidence,
        ))
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


def with_sung_ends(
    words: list[AlignedWord], samples: np.ndarray, instrumental: np.ndarray | None = None
) -> list[AlignedWord]:
    """Stretches each word to the end of the sound it starts.

    The model marks a letter by the instant it is recognised, so a held vowel looks short; the end of a word is where the
    voice really stops, at most where the next word begins.
    """
    voiced = singing_frames(samples, instrumental, _VOICE_RATE, _VOICE_HOP)
    harmonics = harmonic_evidence(samples, _VOICE_RATE, _VOICE_HOP) if instrumental is not None else None
    step = _VOICE_HOP / _VOICE_RATE
    result: list[AlignedWord] = []
    for index, word in enumerate(words):
        limit = words[index + 1].start if index + 1 < len(words) else len(voiced) * step
        continued = continued_frames(voiced, harmonics, (word.start, word.end, limit), step)
        frame = min(int(word.end / step), len(voiced) - 1)
        while frame + 1 < len(continued) and continued[frame] and (frame + 1) * step < limit:
            frame += 1
        end = max(word.end, min(frame * step, limit))
        silence = _first_long_silence(continued, word.start, end, step)
        letters = word.letters
        if silence is not None:
            end = max(silence, word.start + _MINIMUM_WORD_SECONDS)
            letters = _clamped_letters(word.letters, 0.0, word.start, end)
        result.append(
            AlignedWord(
                word.text,
                word.start,
                round(max(end, word.start + _MINIMUM_WORD_SECONDS), 3),
                letters,
                word.score,
            )
        )
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
    heard_start: float | None = None


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
    scores: torch.Tensor,
    frame_seconds: float,
    words: Sequence[str],
    windows: Sequence[Window],
    heard: Mapping[int, float] = MappingProxyType({}),
    voiced: np.ndarray | None = None,
    whole: Sequence[AlignedWord] | None = None,
) -> list[AlignedWord]:
    """Aligns the text against the whole song and, for each stretch with a known place, inside that part of the audio.

    Where the whole-song alignment is unsure (a noisy intro, a break) the guided one is usually right; where the hint is
    wrong (a repeated chorus matched to the wrong repeat) the whole-song one is. The placement the model finds more
    probable is kept, stretch by stretch, unless the words Whisper heard (``heard``: word index -> second) clearly put
    the stretch's words where only one of the two placements has them and that placement does not start words in
    silence or crush them more often (``voiced``: per-10-ms vocal activity). The model alone confuses neighbouring
    phrases of a held, repeated melody ("Please | stay" both sung on the same notes). A window too short for its words
    shares its time among them evenly. ``whole`` is the whole-song alignment when the caller already has it.
    """
    if whole is None:
        whole = align_words(scores, frame_seconds, words)
    result: list[AlignedWord] = []
    for window in windows:
        chunk = list(words[window.first : window.last])
        if not chunk:
            continue
        guided = _align_window(scores, frame_seconds, chunk, window)
        reference = list(whole[window.first : window.last])
        candidates = [candidate for candidate in (guided, reference)
                      if not result or candidate[0].start >= result[-1].start]
        result.extend(candidates[0] if len(candidates) == 1 else
                      _preferred(guided, reference, window.first, heard, voiced))
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
    changed = [index for index, (left, right) in enumerate(zip(guided, reference, strict=True))
               if max(abs(left.start - right.start), abs(left.end - right.end))
               > _HEARD_DISAGREEMENT_SECONDS]
    local_heard = {first + index: heard[first + index] for index in changed
                   if first + index in heard} if changed else heard
    guided_miss = _heard_distance(guided, first, local_heard)
    reference_miss = _heard_distance(reference, first, local_heard)
    if (
        guided_miss is not None
        and reference_miss is not None
        and abs(guided_miss - reference_miss) > _HEARD_DISAGREEMENT_SECONDS
    ):
        closer, other = (
            (guided, reference) if guided_miss < reference_miss else (reference, guided)
        )
        if voiced is None or _implausible(closer, voiced) <= _implausible(other, voiced):
            return closer
    left = [guided[index] for index in changed] if changed else guided
    right = [reference[index] for index in changed] if changed else reference
    return guided if _confidence(left) > _confidence(right) + _PREFERENCE else reference


def _heard_distance(words: Sequence[AlignedWord], first: int, heard: Mapping[int, float]) -> float | None:
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
        if word.end - word.start < _CRAMMED_WORD_SECONDS and sum(c.isalnum() for c in word.text) >= 2:
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


def ordered(words: list[AlignedWord]) -> list[AlignedWord]:
    """Settle overlaps at the next word's start, without propagating one bad end through later words.

    Only reversed starts need moving. Duration alone cannot tell whether a long word or an unequal
    letter interval is wrong; audio evidence belongs to the alignment/refinement stages.
    """
    starts: list[float] = []
    cursor = 0.0
    for word in words:
        start = max(word.start, cursor)
        starts.append(start)
        # Reserve only one serialized millisecond; real fast words need no 50-ms speech minimum.
        cursor = start + 0.001
    result: list[AlignedWord] = []
    for index, word in enumerate(words):
        start = starts[index]
        end = max(word.end, start + 0.001)
        if index + 1 < len(starts):
            end = min(end, starts[index + 1])
        letters = _clamped_letters(word.letters, 0.0, start, end)
        result.append(AlignedWord(word.text, round(start, 3), round(end, 3), letters, word.score))
    return result
