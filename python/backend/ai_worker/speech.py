from __future__ import annotations

import os
from collections.abc import (
    Callable as Callable,
    Iterable as Iterable,
    Mapping as Mapping,
    Sequence as Sequence,
)
from dataclasses import dataclass as dataclass
from functools import partial as partial
from pathlib import Path as Path

import numpy as np
import torch
import whisper

from backend.ai.catalog import SPEECH_MODEL as SPEECH_MODEL
import backend.ai_worker.acoustic_retry as acoustic_retry
import backend.ai_worker.asr_recovery as asr_recovery
import backend.ai_worker.asr_substitution as asr_substitution
from backend.ai_worker.asr_views import token_key
from backend.ai_worker.guidance_prefix import preserve_prefix
from backend.ai_worker.speech_alignment import _AlignmentPass as _AlignmentPass
from backend.ai_worker.speech_observations import RecognitionObservations, recognition_views
from backend.ai_worker.ctc_bounds import _preserved_onset_letters as _preserved_onset_letters
from backend.ai_worker.audio_io import read_mono as read_mono
from backend.ai_worker.ctc import (
    AlignedWord as AlignedWord,
    Window as Window,
    align_guided as align_guided,
    align_words as align_words,
    emission as emission,
    frame_stride_samples as frame_stride_samples,
    _model as alignment_model,
    ordered as ordered,
    with_sung_ends as with_sung_ends,
    with_sung_letters as with_sung_letters,
    with_voice_onsets as with_voice_onsets,
)
from backend.ai_worker.paths import model_directory as model_directory, model_file as model_file
from backend.ai_worker.runtime import (
    AlignmentReuse as AlignmentReuse,
    WHISPER_LANGUAGES as WHISPER_LANGUAGES,
    cached_encoder as cached_encoder,
    cpu_threads as cpu_threads,
    device as device,
)
from backend.ai_worker.timing import (
    audible_frames as audible_frames,
    _levels as _levels,
    harmonic_evidence as harmonic_evidence,
    singing_frames as singing_frames,
    vocal_onsets as vocal_onsets,
    voiced_frames as voiced_frames,
)
from backend.ai_worker.recognition import (
    HeardWord as HeardWord,
    alignment_payload as alignment_payload,
    boundary_conflicts as boundary_conflicts,
    guidance_positions as guidance_positions,
    contextual_guidance as contextual_guidance,
    phrase_coverage as phrase_coverage,
    independent_words as independent_words,
    independent_timings as independent_timings,
    recover_leading_words as recover_leading_words,
    recover_vocalizations as recover_vocalizations,
    with_acoustic_repeats as with_acoustic_repeats,
    with_lead_vocals as with_lead_vocals,
    heard_words as heard_words,
    heard_timings as _heard_timings,
    rate_review_indices as rate_review_indices,
)
from backend.ai_worker.word_guidance import (
    _character_intervals as _character_intervals,
    _key as _key,
    with_word_guidance as with_word_guidance,
)

from backend.ai_worker.speech_windows import (
    _HOP as _HOP,
    _MARGIN_SECONDS as _MARGIN_SECONDS,
    _MINIMUM_BLOCK as _MINIMUM_BLOCK,
    _SAMPLE_RATE as _SAMPLE_RATE,
    _alignment_windows as _alignment_windows,
    _hint_windows as _hint_windows,
    _phrase_windows as _phrase_windows,
    _shifted_hints as _shifted_hints,
    _unique_anchors as _unique_anchors,
    _windows as _windows,
)


def prepare_accelerator() -> dict[str, str]:
    target = model_directory(SPEECH_MODEL)
    target.mkdir(parents=True, exist_ok=True)
    if not (target / "model.bin").is_file():
        # Whisper verifies the checksum encoded in the official URL before returning.
        checkpoint = Path(
            whisper._download(SPEECH_MODEL.download_url, str(target), in_memory=False)
        )
        checkpoint.replace(target / "model.bin")
    return {"acceleratedWhisper": str(target)}


def _load_speech_model(path: str, target: str) -> whisper.Whisper:
    checkpoint = torch.load(path, map_location="cpu", weights_only=True, mmap=True)
    dims = whisper.ModelDimensions(**checkpoint["dims"])
    with torch.device("meta"):
        model = whisper.Whisper.__new__(whisper.Whisper)
        torch.nn.Module.__init__(model)
        model.dims = dims
        model.encoder = whisper.model.AudioEncoder(
            dims.n_mels, dims.n_audio_ctx, dims.n_audio_state, dims.n_audio_head, dims.n_audio_layer
        )
        model.decoder = whisper.model.TextDecoder(
            dims.n_vocab, dims.n_text_ctx, dims.n_text_state, dims.n_text_head, dims.n_text_layer
        )
    # This nonpersistent buffer is absent from the checkpoint; retain the native causal mask.
    model.decoder.mask = torch.empty(dims.n_text_ctx, dims.n_text_ctx).fill_(-np.inf).triu_(1)
    for layer in model.modules() if target == "cuda" else ():
        if isinstance(layer, (torch.nn.Linear, torch.nn.Conv1d, torch.nn.Embedding)):
            layer.half()
    expected = model.state_dict()
    weights = {
        key: value.to(
            device=target, dtype=expected[key].dtype, memory_format=torch.contiguous_format
        ).contiguous()
        for key, value in checkpoint["model_state_dict"].items()
    }
    model.load_state_dict(weights, assign=True)
    return model


def _speech_model(target: str) -> whisper.Whisper:
    # Keep checkpoint precision for projections/embeddings; avoid recasting the vocabulary per token.
    model = _load_speech_model(str(model_file(SPEECH_MODEL)), target=target)
    for layer in model.modules() if target == "cuda" else ():
        if isinstance(layer, (torch.nn.Linear, torch.nn.Conv1d, torch.nn.Embedding)):
            layer.half()
    if target == "cuda":
        model.to(target)
    name = SPEECH_MODEL.model_id.removeprefix("whisper-")
    model.set_alignment_heads(whisper._ALIGNMENT_HEADS[name])
    directory = os.getenv("AD_VOICE_TENSORRT_WHISPER")
    if target == "cuda" and directory:
        from backend.ai_worker.tensorrt_pitch import TensorRTEncoder

        model.encoder = torch.nn.Identity()
        torch.cuda.empty_cache()
        model.encoder = TensorRTEncoder(Path(directory))
    return model


def _transcribe(
    vocal: Path | np.ndarray, language: str, prompt: str | None
) -> Mapping[str, object]:
    model = _speech_model(target := device())
    with torch.inference_mode(), cached_encoder(model.encoder):
        result: Mapping[str, object] = model.transcribe(
            vocal if isinstance(vocal, np.ndarray) else str(vocal),
            language=WHISPER_LANGUAGES.get(language),
            word_timestamps=True,
            initial_prompt=prompt,
            fp16=target == "cuda",
            condition_on_previous_text=False,
            temperature=0.0,
        )
    return result


def _accelerated_guidance(
    vocal: Path | np.ndarray,
    language: str,
    prompt: str | None,
    contexts: Sequence[tuple[float, float, str | None]] = (),
    *,
    threads: int | None = None,
    model_cache: list[whisper.Whisper] | None = None,
    reuse: AlignmentReuse | None = None,
) -> Mapping[str, object]:
    """Use the native decoder: converted decoding omitted whole sung repeats in real recordings."""
    torch.set_num_threads(threads or cpu_threads())
    samples = vocal if isinstance(vocal, np.ndarray) else read_mono(vocal, _SAMPLE_RATE)
    models = model_cache if model_cache is not None else []
    results = []
    for start, end, vocabulary in contexts or [(0.0, 0.0, prompt)]:
        audio = (
            samples[int(start * _SAMPLE_RATE) : int(end * _SAMPLE_RATE)] if contexts else samples
        )
        calculate = partial(_decode_context, audio, language, vocabulary, start, models, reuse)
        result = (
            calculate()
            if reuse is None
            else reuse.context(
                b"context:" + repr((language, vocabulary, start)).encode() + audio.tobytes(),
                calculate,
            )
        )
        results.append(result)
    return {"contexts": results} if contexts else results[0]


def _decode_context(
    audio: np.ndarray,
    language: str,
    prompt: str | None,
    start: float,
    models: list[whisper.Whisper],
    reuse: AlignmentReuse | None,
) -> Mapping[str, object]:
    model = models.pop() if models else _speech_model(device())
    with torch.inference_mode(), cached_encoder(model.encoder, reuse=reuse):
        result = model.transcribe(
            audio,
            language=WHISPER_LANGUAGES.get(language),
            word_timestamps=True,
            initial_prompt=prompt,
            condition_on_previous_text=False,
            fp16=device() == "cuda",
            temperature=0.0,
        )
    for segment in result.get("segments", []):
        for item in [segment, *segment.get("words", [])]:
            for key in ("start", "end"):
                item[key] += start
    models.append(model)
    return dict(result)


def _guidance(
    vocal: Path | np.ndarray,
    language: str,
    prompt: str | None,
    threads: int | None = None,
    *,
    prefer_accelerated: bool = False,
    model_cache: list[whisper.Whisper] | None = None,
    reuse: AlignmentReuse | None = None,
) -> Mapping[str, object]:
    if device() == "cuda" and not prefer_accelerated:
        return _transcribe(vocal, language, prompt)
    try:
        return _accelerated_guidance(
            vocal, language, prompt, threads=threads, model_cache=model_cache, reuse=reuse
        )
    except (FileNotFoundError, OSError, RuntimeError, ValueError):
        return _transcribe(vocal, language, prompt)


def transcribe(
    vocal: Path,
    language: str,
    *,
    start_seconds: float = 0.0,
    model_cache: list[whisper.Whisper] | None = None,
) -> dict[str, object]:
    source = (
        read_mono(vocal, _SAMPLE_RATE)[round(start_seconds * _SAMPLE_RATE) :]
        if start_seconds
        else vocal
    )
    result = _guidance(source, language, None, prefer_accelerated=True, model_cache=model_cache)
    return _transcription_payload(result)


def _transcription_payload(result: Mapping[str, object]) -> dict[str, object]:
    # Recognition of singing sometimes invents symbols and numbers ("1.5%"); only words with letters are lyrics.
    text = [
        token for token in str(result.get("text", "")).split() if any(c.isalpha() for c in token)
    ]
    heard = heard_words(result, include_untimed=True)
    # A decoder can repeat many words at one instant; these cannot establish sung repeats.
    if any(start >= end for _, start, end in heard) and "".join(
        _key(token) for token in text
    ) == "".join(word for word, _, _ in heard):
        intervals = _character_intervals(text, heard, 0)
        text = [
            token for index, token in enumerate(text) if intervals[index][0] < intervals[index][1]
        ]
    segments = result.get("segments", [])
    lines = [
        [token for token in segment["text"].split() if any(c.isalpha() for c in token)]
        for segment in (segments if isinstance(segments, list) else [])
        if isinstance(segment, dict) and isinstance(segment.get("text"), str)
    ]
    transcript = (
        "\n".join(" ".join(line) for line in lines if line)
        if [token for line in lines for token in line] == text
        else " ".join(text)
    )
    return {"text": transcript, "segments": segments}


def transcribe_many(
    requests: Iterable[tuple[Path, float]], language: str
) -> dict[str, list[dict[str, object]]]:
    models: list[whisper.Whisper] = []
    return {
        "transcriptions": [
            transcribe(audio, language, start_seconds=start, model_cache=models)
            for audio, start in requests
        ]
    }


def _observed_guidance(
    language: str,
    threads: int,
    reuse: AlignmentReuse | None,
    observations: RecognitionObservations | None,
    source: Path | np.ndarray,
) -> Mapping[str, object]:
    result = _guidance(source, language, None, threads, prefer_accelerated=True, reuse=reuse)
    if observations is not None:
        observations.record(source, _transcription_payload(result))
    return result


def _alignment_evidence(
    vocal: Path,
    samples: np.ndarray,
    language: str,
    lyrics: str,
    instrumental: np.ndarray | None = None,
    recognition: Mapping[str, object] | None = None,
    independent_views: list[list[tuple[str, float, float]]] | None = None,
    reuse: AlignmentReuse | None = None,
    observations: RecognitionObservations | None = None,
) -> tuple[torch.Tensor, float, list[tuple[str, float, float]]]:
    """Independent recognition precedes CTC; the native models do not compete for memory."""
    threads = cpu_threads()
    candidates = independent_words(
        vocal,
        samples,
        instrumental,
        recognition,
        partial(_observed_guidance, language, threads, reuse, observations),
    )
    if independent_views is not None:
        independent_views.extend(candidates)
    heard = _best_alignment_view(lyrics, candidates)
    torch.set_num_threads(threads)
    scores, frame_seconds = _alignment_emission(samples, reuse)
    scores = acoustic_retry.recover_emission(
        samples,
        scores,
        frame_seconds,
        lyrics,
        _full_recognition_views(
            recognition, candidates, observations.views if observations else ()
        ),
        partial(_alignment_emission, reuse=reuse),
    )
    alignment_model.cache_clear()
    return scores, frame_seconds, heard


def _best_alignment_view(lyrics: str, candidates: Sequence[list[HeardWord]]) -> list[HeardWord]:
    return max(
        candidates,
        key=lambda view: (
            phrase_coverage(lyrics, view),
            len(_heard_timings(lyrics.split(), view, minimum_block=_MINIMUM_BLOCK)),
        ),
        default=[],
    )


def _alignment_emission(
    samples: np.ndarray, reuse: AlignmentReuse | None = None
) -> tuple[torch.Tensor, float]:
    if reuse is None:
        return emission(samples)
    # The frame grid is fixed by MMS; only the audio-dependent scores are reused.
    scores = reuse.tensor(b"ctc:" + samples.tobytes(), lambda: emission(samples)[0])
    return scores, frame_stride_samples() / _SAMPLE_RATE


def _full_recognition_views(
    recognition: Mapping[str, object] | None,
    candidates: Sequence[list[HeardWord]],
    fresh: Sequence[Mapping[str, object]] = (),
) -> list[list[HeardWord]]:
    raw = [*recognition_views(recognition), *fresh]
    views: list[list[HeardWord]] = []
    sources: set[str] = set()
    for raw_view in raw:
        source = raw_view.get("sourceId")
        if raw_view.get("cropStart", raw_view.get("startSeconds", 0)) or (
            isinstance(source, str) and source in sources
        ):
            continue
        views.append(heard_words(raw_view))
        if isinstance(source, str) and source:
            sources.add(source)
    if not raw:
        views = list(candidates)
    # Reconstructed full views contain the same observed prefix. They cannot
    # corroborate one another when deciding whether another model call is justified.
    unique: list[list[HeardWord]] = []
    for view in views:
        if view and view not in unique:
            unique.append(view)
    return unique


def align(
    vocal: Path,
    lyrics: str,
    language: str,
    timing_hints: Sequence[Mapping[str, object]] = (),
    instrumental: Path | None = None,
    recognition: Mapping[str, object] | None = None,
    *,
    reuse: AlignmentReuse | None = None,
    asr_lyrics: bool = False,
    asr_baseline: str = "",
) -> dict[str, object]:
    audio = read_mono(vocal, _SAMPLE_RATE)
    backing = read_mono(instrumental, _SAMPLE_RATE) if instrumental is not None else None
    observations = RecognitionObservations(audio, language, recognition)
    evidence = partial(
        _alignment_evidence,
        vocal,
        audio,
        language,
        lyrics,
        backing,
        recognition,
        views := list[list[HeardWord]](),
    )
    evidence = partial(evidence, observations=observations) if asr_lyrics else evidence
    scores, step, heard = evidence() if reuse is None else evidence(reuse=reuse)
    if asr_lyrics:
        original = lyrics
        lyrics, verified = _recover_transcript_lyrics(
            lyrics, observations, scores, step, asr_baseline
        )
        heard = preserve_prefix(original, lyrics, heard, _best_alignment_view(lyrics, views) or heard)
    recognize = partial(_accelerated_guidance, audio, language, None, model_cache=[], reuse=reuse)
    payload = _AlignmentPass(
        audio, backing, scores, step, lyrics.split(), lyrics, heard, views
    ).run(timing_hints, recognize)
    if not asr_lyrics:
        return dict(payload)
    return _asr_payload(lyrics, payload, observations, scores, step, verified)


def _recover_transcript_lyrics(
    lyrics: str,
    observations: RecognitionObservations,
    scores: torch.Tensor,
    step: float,
    baseline_lyrics: str = "",
) -> tuple[str, bool]:
    views = [*recognition_views(observations.recognition), *observations.views]
    duration = len(observations.samples) / _SAMPLE_RATE
    floor = baseline_lyrics or lyrics
    recovered = (
        asr_recovery.recover_lyrics(floor, views, scores, step, duration) if views else floor
    )
    remaining = iter(map(token_key, recovered.split()))
    # Discovery may already have found repeats. Keep its existing acoustic check
    # unless recovery also preserves every proposed occurrence in its original order.
    preserved = all(
        any(word == expected for word in remaining) for expected in map(token_key, lyrics.split())
    )
    return (recovered, True) if preserved else (lyrics, False)


def _asr_payload(
    lyrics: str,
    payload: Mapping[str, object],
    observations: RecognitionObservations,
    scores: torch.Tensor,
    step: float,
    verified: bool,
) -> dict[str, object]:
    if verified:
        views = [*recognition_views(observations.recognition), *observations.views]
        lyrics, payload = asr_substitution.substitute_alignment(
            lyrics, payload, views, scores, step, len(observations.samples) / _SAMPLE_RATE
        )
    return dict(payload, lyrics=lyrics, insertionsVerified=verified)
