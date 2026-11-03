from __future__ import annotations
from collections.abc import Sequence
from functools import lru_cache
from math import prod
import numpy as np
import torch
import torchaudio
from torchaudio.functional import forced_align, merge_tokens
from torchaudio.pipelines import MMS_FA
from torchaudio.pipelines._wav2vec2.utils import _extend_model
from backend.ai.catalog import ALIGNMENT_MODEL
from backend.ai_worker.paths import model_file
from backend.ai_worker.runtime import device
from backend.moment_spreading import spread_tied_moments

from backend.ai_worker.ctc_domain import (
    AlignedWord as AlignedWord,
    _CHUNK_SECONDS as _CHUNK_SECONDS,
    _CONTEXT_SECONDS as _CONTEXT_SECONDS,
    _MINIMUM_WORD_SECONDS as _MINIMUM_WORD_SECONDS,
)
from backend.ai_worker.ctc_tokens import (
    _character_tokens as _character_tokens,
)
from backend.ai_worker.ctc_bounds import (
    _filled_letters as _filled_letters,
)


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
