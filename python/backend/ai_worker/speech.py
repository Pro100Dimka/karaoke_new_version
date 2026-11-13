from __future__ import annotations

import os
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from functools import partial
from pathlib import Path

import numpy as np
import torch
import whisper

from backend.ai.catalog import SPEECH_MODEL
from backend.ai_worker.ctc_bounds import (
    _preserved_onset_letters as _preserved_onset_letters,
)
from backend.ai_worker.audio_io import read_mono
from backend.ai_worker.ctc import (
    AlignedWord,
    Window,
    align_guided,
    align_words,
    emission,
    frame_stride_samples,
    _model as alignment_model,
    ordered,
    with_sung_ends,
    with_sung_letters,
    with_voice_onsets,
)
from backend.ai_worker.paths import model_directory, model_file
from backend.ai_worker.runtime import (
    AlignmentReuse,
    WHISPER_LANGUAGES,
    cached_encoder,
    cpu_threads,
    device,
)
from backend.ai_worker.timing import (
    audible_frames,
    _levels,
    harmonic_evidence,
    singing_frames,
    vocal_onsets,
    voiced_frames,
)
from backend.ai_worker.recognition import (
    HeardWord,
    alignment_payload,
    boundary_conflicts,
    guidance_positions,
    contextual_guidance,
    phrase_coverage,
    independent_words,
    independent_timings,
    recover_leading_words,
    recover_vocalizations,
    with_acoustic_repeats,
    backing_overlap_indices,
    heard_words,
    heard_timings as _heard_timings,
    rate_review_indices,
)
from backend.ai_worker.word_guidance import (
    _character_intervals,
    _key,
    with_word_guidance,
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
    return {"text": " ".join(text), "segments": result.get("segments", [])}


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


def _alignment_evidence(
    vocal: Path,
    samples: np.ndarray,
    language: str,
    lyrics: str,
    instrumental: np.ndarray | None = None,
    recognition: Mapping[str, object] | None = None,
    independent_views: list[list[tuple[str, float, float]]] | None = None,
    reuse: AlignmentReuse | None = None,
) -> tuple[torch.Tensor, float, list[tuple[str, float, float]]]:
    """Independent recognition precedes CTC; the native models do not compete for memory."""
    threads = cpu_threads()
    candidates = independent_words(
        vocal,
        samples,
        instrumental,
        recognition,
        lambda source: _guidance(
            source, language, None, threads, prefer_accelerated=True, reuse=reuse
        ),
    )
    if independent_views is not None:
        independent_views.extend(candidates)
    heard = max(
        candidates,
        key=lambda view: (
            phrase_coverage(lyrics, view),
            len(_heard_timings(lyrics.split(), view, minimum_block=_MINIMUM_BLOCK)),
        ),
    )
    torch.set_num_threads(threads)
    if reuse is None:
        scores, frame_seconds = emission(samples)
    else:
        # The frame grid is fixed by MMS; only the audio-dependent scores are reused.
        scores = reuse.tensor(b"ctc:" + samples.tobytes(), lambda: emission(samples)[0])
        frame_seconds = frame_stride_samples() / _SAMPLE_RATE
    alignment_model.cache_clear()
    return scores, frame_seconds, heard


def align(
    vocal: Path,
    lyrics: str,
    language: str,
    timing_hints: Sequence[Mapping[str, object]] = (),
    instrumental: Path | None = None,
    recognition: Mapping[str, object] | None = None,
    *,
    reuse: AlignmentReuse | None = None,
) -> dict[str, list[dict[str, float | str | list[float] | list[str]]]]:
    audio, words = read_mono(vocal, _SAMPLE_RATE), lyrics.split()
    backing = read_mono(instrumental, _SAMPLE_RATE) if instrumental is not None else None
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
    scores, step, heard = evidence() if reuse is None else evidence(reuse=reuse)
    recognize = partial(_accelerated_guidance, audio, language, None, model_cache=[], reuse=reuse)
    return _AlignmentPass(audio, backing, scores, step, words, lyrics, heard, views).run(
        timing_hints, recognize
    )


@dataclass(slots=True)
class _AlignmentPass:
    audio: np.ndarray
    backing: np.ndarray | None
    scores: torch.Tensor
    step: float
    words: list[str]
    lyrics: str
    heard: list[HeardWord]
    views: list[list[HeardWord]]

    def run(
        self,
        timing_hints: Sequence[Mapping[str, object]],
        recognize: partial[Mapping[str, object]],
    ) -> dict[str, list[dict[str, float | str | list[float] | list[str]]]]:
        whole = align_words(self.scores, self.step, self.words)
        self.heard = recover_leading_words(self.lyrics, whole, self.heard, recognize)
        guided, guide, voiced, activity, supported = self._guide_alignment(
            timing_hints, whole, recognize
        )
        return self._refine_alignment(supported, guided, guide, voiced, activity, recognize)

    def _guide_alignment(
        self,
        timing_hints: Sequence[Mapping[str, object]],
        whole: list[AlignedWord],
        recognize: partial[Mapping[str, object]],
    ) -> tuple[
        list[AlignedWord],
        partial[list[AlignedWord]],
        np.ndarray,
        np.ndarray,
        dict[int, tuple[float, float]],
    ]:
        windows = _alignment_windows(self.lyrics, timing_hints, self.heard, whole, self.audio)
        windows, supported = contextual_guidance(
            self.words,
            windows,
            whole,
            _heard_timings(
                self.words, self.heard, whole, minimum_block=_MINIMUM_BLOCK, windows=windows
            ),
            activity := singing_frames(self.audio, self.backing, _SAMPLE_RATE, _HOP),
            recognize,
        )
        positions = guidance_positions(
            _heard_timings(self.words, self.heard, whole, windows=windows) | supported, windows
        )
        guided, guide, voiced = self._guided_words(windows, supported, whole, positions)
        return guided, guide, voiced, activity, supported

    def _guided_words(
        self,
        windows: Sequence[Window],
        supported: dict[int, tuple[float, float]],
        whole: list[AlignedWord],
        positions: Mapping[int, float],
    ) -> tuple[list[AlignedWord], partial[list[AlignedWord]], np.ndarray]:
        voiced = voiced_frames(self.audio, _SAMPLE_RATE, _HOP)
        guide = partial(
            with_word_guidance,
            scores=self.scores,
            frame_seconds=self.step,
            windows=windows,
            heard=supported,
            voiced=voiced,
            margin=_MARGIN_SECONDS,
            recognized=self.heard,
            alternatives=self.views,
            onsets=vocal_onsets(self.audio, _SAMPLE_RATE, _HOP).tolist(),
        )
        guided = guide(
            align_guided(
                self.scores,
                self.step,
                self.words,
                windows,
                positions,
                voiced,
                whole,
                anchors={index: interval[0] for index, interval in supported.items()},
            )
        )
        return guided, guide, voiced

    def _refine_alignment(
        self,
        supported: dict[int, tuple[float, float]],
        guided: list[AlignedWord],
        guide: partial[list[AlignedWord]],
        voiced: np.ndarray,
        activity: np.ndarray,
        recognize: partial[Mapping[str, object]],
    ) -> dict[str, list[dict[str, float | str | list[float] | list[str]]]]:
        acoustic = harmonic_evidence(self.audio, _SAMPLE_RATE, _HOP)
        harmonics = acoustic if self.backing is not None else None
        audible = audible_frames(self.audio, _HOP)
        started = with_voice_onsets(
            guided, self.audio, voiced,
            supported | independent_timings(self.words, [self.heard, *self.views], guided),
        )

        def sung_ends(values: list[AlignedWord]) -> list[AlignedWord]:
            return with_sung_ends(
                values, self.audio, self.backing, activity, harmonics, audible, acoustic[1]
            )

        timed = ordered(sung_ends(started))
        intervals = supported | independent_timings(self.words, [self.heard, *self.views], timed)
        reviewed = rate_review_indices(timed, self.lyrics, heard=intervals, activity=activity)
        reviewed |= boundary_conflicts(guided)
        timed, recovered = self._recover_alignment(
            guided, started, timed, reviewed, intervals, guide, activity, voiced, sung_ends
        )
        timed = with_sung_letters(timed, self.scores, self.step, activity, intervals)
        timed = with_acoustic_repeats(
            timed,
            vocal_onsets(self.audio, _SAMPLE_RATE, _HOP).tolist(),
            acoustic,
            activity,
            _levels(self.audio, _HOP)[0],
            intervals,
        )
        backing = backing_overlap_indices(timed, self.views, activity, acoustic[1])
        timed = [
            replace(word, diagnostics=(*word.diagnostics, "BackingVocalOverlap"))
            if index in backing
            else word
            for index, word in enumerate(timed)
        ]
        vowels = recover_vocalizations(
            timed, self.scores, self.step, activity, acoustic[1], recognize
        )
        extended = {
            (word.start, word.text): word
            for word in vowels
            if "VocalizationRetimed" in word.diagnostics
        }
        timed = [extended.get((word.start, word.text), word) for word in timed]
        recovered_vowels = [word for word in vowels if "RecoveredVocalization" in word.diagnostics]
        payload = alignment_payload(
            timed,
            independent_timings(self.words, [self.heard, *self.views], timed),
            recovered=recovered,
            reviewed=frozenset(
                rate_review_indices(timed, self.lyrics, heard=intervals, activity=activity)
            ),
        )
        payload["words"].extend(alignment_payload(recovered_vowels, {})["words"])
        payload["words"] = [
            value
            for _, value in sorted(
                zip([*timed, *recovered_vowels], payload["words"]), key=lambda pair: pair[0].start
            )
        ]
        return payload

    def _recover_alignment(
        self,
        guided: list[AlignedWord],
        started: list[AlignedWord],
        timed: list[AlignedWord],
        reviewed: set[int],
        intervals: Mapping[int, tuple[float, float]],
        guide: partial[list[AlignedWord]],
        activity: np.ndarray,
        voiced: np.ndarray,
        sung_ends: Callable[[list[AlignedWord]], list[AlignedWord]],
    ) -> tuple[list[AlignedWord], frozenset[int]]:
        recovered: frozenset[int] = frozenset()
        if reviewed:
            cores = guide(guided, heard=intervals, voiced=activity, reviewed=frozenset(reviewed))
            if cores != guided:
                adjusted = with_voice_onsets(cores, self.audio, voiced)
                # Recalibrating one onset must not shift distant unchanged cores. Keep
                # jointly accepted neighbours, then recompute the affected preceding ends.
                local = [
                    _preserved_onset_letters(guided[i], cores[i], started[i], word)
                    if cores[i] != guided[i]
                    else started[i]
                    for i, word in enumerate(adjusted)
                ]
                repaired = ordered(sung_ends(local))
                # Commit the accepted sequence together: restoring its old neighbour cuts it again.
                recovered = frozenset(i for i, word in enumerate(repaired) if word != timed[i])
                timed = repaired
        return timed, recovered
