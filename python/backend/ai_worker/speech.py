from __future__ import annotations

import difflib
import threading
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from functools import partial
from pathlib import Path

import numpy as np
import torch
import whisper

from backend.ai.catalog import SPEECH_MODEL
from backend.lyrics.discovery import performed_phrases
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
from backend.ai_worker.timing import singing_frames, vocal_onsets, voiced_frames
from backend.ai_worker.recognition import (
    HeardWord,
    alignment_payload,
    boundary_conflicts,
    guidance_positions,
    contextual_guidance,
    unhinted_windows,
    phrase_coverage,
    independent_words,
    independent_timings,
    recover_leading_words,
    heard_words,
    heard_timings as _heard_timings,
    rate_review_indices,
)
from backend.ai_worker.word_guidance import (
    _character_intervals,
    _key,
    _matching_blocks,
    phrase_window,
    recognized_phrase,
    with_word_guidance,
)

_SAMPLE_RATE = 16_000
_MINIMUM_BLOCK = 3
_MARGIN_SECONDS = 0.6
_HOP = 160
# Snap approximate catalogue entries to nearby vocal onsets without borrowing neighbouring phrases.
_ONSET_SNAP_LATER_SECONDS = 0.3
_ONSET_LEAD_SECONDS = 0.05
# Correct catalogue release offsets only when CTC line starts show a consistent nontrivial shift.
_CATALOG_SHIFT_MINIMUM_SECONDS = 0.3
_CATALOG_SHIFT_MAXIMUM_SPREAD_SECONDS = 0.5
_CATALOG_SHIFT_MINIMUM_LINES = 5


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


def _speech_model(target: str) -> whisper.Whisper:
    # Keep checkpoint precision for projections/embeddings; avoid recasting the vocabulary per token.
    model = whisper.load_model(str(model_file(SPEECH_MODEL)), device="cpu")
    for layer in model.modules() if target == "cuda" else ():
        if isinstance(layer, (torch.nn.Linear, torch.nn.Conv1d, torch.nn.Embedding)):
            layer.half()
    if target == "cuda":
        model.to(target)
    name = SPEECH_MODEL.model_id.removeprefix("whisper-")
    model.set_alignment_heads(whisper._ALIGNMENT_HEADS[name])
    return model


def _transcribe(
    vocal: Path | np.ndarray, language: str, prompt: str | None
) -> Mapping[str, object]:
    model = _speech_model(target := device())
    with cached_encoder(model.encoder):
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
    with cached_encoder(model.encoder, reuse=reuse):
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


def _windows(
    words: list[str],
    heard: list[tuple[str, float, float]],
    total: float,
    whole: Sequence[AlignedWord] | None = None,
    *,
    blocks: Sequence[difflib.Match] | None = None,
) -> list[Window]:
    """Pin matching runs to ASR time; put intervening text in the audio between those runs."""
    if blocks is None:
        blocks = [
            block for block in _matching_blocks(words, heard, whole) if block.size >= _MINIMUM_BLOCK
        ]
    if not blocks:
        return [Window(0, len(words), 0.0, total)]
    windows: list[Window] = []
    text_cursor, audio_cursor = 0, 0.0
    for block in blocks:
        start, end = (
            heard[block.b][1] - _MARGIN_SECONDS,
            heard[block.b + block.size - 1][2] + _MARGIN_SECONDS,
        )
        if block.a > text_cursor:
            windows.append(Window(text_cursor, block.a, audio_cursor, max(start, audio_cursor)))
        windows.append(
            Window(
                block.a,
                block.a + block.size,
                max(start, 0.0),
                end,
                heard[block.b][1],
            )
        )
        text_cursor, audio_cursor = block.a + block.size, end
    if text_cursor < len(words):
        windows.append(Window(text_cursor, len(words), audio_cursor, total))
    return windows


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


def _line_first_words(
    words: list[str], hints: Sequence[Mapping[str, object]]
) -> list[tuple[int, float, str]]:
    """(index of the line's first lyric word, timestamp, text) for every catalog line found in order."""
    keys = [_key(word) for word in words]
    found: list[tuple[int, float, str]] = []
    cursor = 0
    for item in hints:
        start, text = item.get("start"), item.get("text")
        if not (
            isinstance(start, (int, float))
            and not isinstance(start, bool)
            and isinstance(text, str)
        ):
            continue
        line = [_key(word) for word in text.split() if _key(word)]
        first = next(
            (
                position
                for position in range(cursor, len(keys) - len(line) + 1)
                if keys[position : position + len(line)] == line
            ),
            None,
        )
        if first is None or not line:
            continue
        found.append((first, float(start), text))
        cursor = first + len(line)
    return found


def _shifted_hints(
    words: list[str],
    hints: Sequence[Mapping[str, object]],
    whole: Sequence[AlignedWord],
    heard: Sequence[HeardWord] = (),
) -> list[dict[str, object]]:
    """Correct release offsets and stale line entries against independently recognized phrases."""
    lines = _line_first_words(words, hints)
    differences = [whole[first].start - start for first, start, _ in lines]
    shift = 0.0
    if len(differences) >= _CATALOG_SHIFT_MINIMUM_LINES:
        middle = float(np.median(differences))
        spread = float(np.percentile(differences, 75) - np.percentile(differences, 25))
        if (
            abs(middle) >= _CATALOG_SHIFT_MINIMUM_SECONDS
            and spread <= _CATALOG_SHIFT_MAXIMUM_SPREAD_SECONDS
        ):
            shift = middle
    supported = _heard_timings(words, list(heard), whole, minimum_block=_MINIMUM_BLOCK)
    result: list[dict[str, object]] = []
    for first, start, text in lines:
        entry = start + shift
        interval = supported.get(first)
        phrase_support = {
            _key(words[index])
            for index in range(first, first + len(text.split()))
            if index in supported
        }
        if (
            interval is not None
            and len(phrase_support) >= _MINIMUM_BLOCK
            and not interval[0] - _MARGIN_SECONDS <= entry <= interval[1] + _MARGIN_SECONDS
        ):
            entry = interval[0]
        result.append({"start": entry, "text": text})
    return result


def _line_start(hint: float, onsets: np.ndarray) -> tuple[float, bool]:
    """Where a catalog line's window opens, and whether a clear voice entry confirmed it."""
    near = onsets[(onsets >= hint - _MARGIN_SECONDS) & (onsets <= hint + _ONSET_SNAP_LATER_SECONDS)]
    if len(near):
        return float(near[np.argmin(np.abs(near - hint))]) - _ONSET_LEAD_SECONDS, True
    return hint - _MARGIN_SECONDS, False


def _hint_windows(
    lyrics: str,
    hints: Sequence[Mapping[str, object]],
    total: float,
    onsets: np.ndarray = np.empty(0),
) -> list[Window]:
    words = lyrics.split()
    lines = _line_first_words(words, hints)
    opens = [_line_start(start, onsets) for _, start, _ in lines]
    windows: list[Window] = []
    cursor, audio_cursor, matched = 0, 0.0, 0
    for index, (first, hint, text) in enumerate(lines):
        last = first + sum(1 for word in text.split() if _key(word))
        window_start = max(0.0, opens[index][0])
        window_end = _line_end(index, lines, opens, total)
        if first > cursor:
            windows.append(Window(cursor, first, audio_cursor, max(audio_cursor, window_start)))
        windows.append(
            Window(
                first,
                last,
                window_start,
                window_end,
                window_start + _ONSET_LEAD_SECONDS if opens[index][1] else hint,
            )
        )
        cursor, audio_cursor, matched = last, window_end, matched + last - first
    if cursor < len(words):
        windows.append(Window(cursor, len(words), audio_cursor, total))
    return windows if matched >= _MINIMUM_BLOCK else []


def _line_end(
    index: int,
    lines: Sequence[tuple[int, float, str]],
    opens: Sequence[tuple[float, bool]],
    total: float,
) -> float:
    """A line's window closes where the next line's voice enters, or a margin after its timestamp."""
    if index + 1 >= len(lines):
        return total
    if opens[index + 1][1]:
        return opens[index + 1][0]
    return min(total, lines[index + 1][1] + _MARGIN_SECONDS)


def _alignment_windows(
    lyrics: str,
    timing_hints: Sequence[Mapping[str, object]],
    heard: list[tuple[str, float, float]],
    whole: Sequence[AlignedWord],
    samples: np.ndarray,
) -> list[Window]:
    words, total = lyrics.split(), len(samples) / _SAMPLE_RATE
    if timing_hints:
        hints = _shifted_hints(words, timing_hints, whole, heard)
        onsets = vocal_onsets(samples, _SAMPLE_RATE, _HOP)
        windows = _hint_windows(lyrics, hints, total, onsets)
        if windows:
            supported = _heard_timings(words, heard, whole, minimum_block=_MINIMUM_BLOCK)
            return unhinted_windows(
                [
                    phrase_window(
                        window,
                        recognized_phrase(
                            window,
                            words[window.first : window.last],
                            heard,
                            _MARGIN_SECONDS,
                            allow_utterance=window.first - 1 in supported
                            and window.last in supported,
                        )[0],
                        whole[window.first].start,
                        supported.get(window.last - 1),
                        _MARGIN_SECONDS,
                    )
                    for window in windows
                ],
                whole,
                _MARGIN_SECONDS,
            )
    return _phrase_windows(lyrics, heard, total, whole) or _windows(words, heard, total, whole)


def _phrase_windows(
    lyrics: str,
    heard: list[tuple[str, float, float]],
    total: float,
    whole: Sequence[AlignedWord],
) -> list[Window]:
    if len(lyrics.splitlines()) < 2:
        return []
    phrases = performed_phrases(lyrics, [word for word, _, _ in heard], threading.Event())
    lines = [line for line in lyrics.splitlines() if line.split()]
    firsts = [0]
    for line in lines:
        firsts.append(firsts[-1] + len(line.split()))
    heard_lines = [(text, heard[first][1], heard[last - 1][2]) for text, first, last in phrases]
    matches = _matching_blocks(
        lines,
        [(_key(text), start, end) for text, start, end in heard_lines],
        [whole[first] for first in firsts[:-1]],
    )
    expanded: list[tuple[str, float, float]] = []
    blocks: list[difflib.Match] = []
    for match in matches:
        for offset in range(match.size):
            text, start, end = heard_lines[match.b + offset]
            words = text.split()
            blocks.append(difflib.Match(firsts[match.a + offset], len(expanded), len(words)))
            expanded.extend(
                (
                    _key(word),
                    start + (end - start) * i / len(words),
                    start + (end - start) * (i + 1) / len(words),
                )
                for i, word in enumerate(words)
            )
    if not blocks:
        return []
    _unique_anchors(lyrics.split(), heard, blocks, expanded)
    return _windows(lyrics.split(), expanded, total, blocks=sorted(blocks, key=lambda b: b.a))


def _unique_anchors(
    words: list[str],
    heard: list[tuple[str, float, float]],
    blocks: list[difflib.Match],
    expanded: list[tuple[str, float, float]],
) -> None:
    keys = [_key(word) for word in words]
    counts, heard_counts = Counter(keys), Counter(word for word, _, _ in heard)
    occupied = {block.a + i for block in blocks for i in range(block.size)}
    positions = {word: index for index, (word, _, _) in enumerate(heard)}
    for index, key in enumerate(keys):
        if index not in occupied and counts[key] == heard_counts[key] == 1:
            candidate = heard[positions[key]]
            before = max(
                (expanded[b.b + b.size - 1][1] for b in blocks if b.a + b.size <= index),
                default=0.0,
            )
            after = min((expanded[b.b][2] for b in blocks if b.a > index), default=float("inf"))
            # ASR may skip this occurrence: require the surrounding phrases even for unique spelling.
            if before <= candidate[1] <= candidate[2] <= after:
                blocks.append(difflib.Match(index, len(expanded), 1))
                expanded.append(candidate)


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
    whole = align_words(scores, step, words)
    recognize = partial(_accelerated_guidance, audio, language, None, model_cache=[], reuse=reuse)
    heard = recover_leading_words(lyrics, whole, heard, recognize)
    windows = _alignment_windows(lyrics, timing_hints, heard, whole, audio)
    windows, supported = contextual_guidance(
        words,
        windows,
        whole,
        _heard_timings(words, heard, whole, minimum_block=_MINIMUM_BLOCK, windows=windows),
        activity := singing_frames(audio, backing, _SAMPLE_RATE, _HOP),
        recognize,
    )
    positions = guidance_positions(
        _heard_timings(words, heard, whole, windows=windows) | supported, windows
    )
    voiced = voiced_frames(audio, _SAMPLE_RATE, _HOP)
    guide = partial(
        with_word_guidance,
        scores=scores,
        frame_seconds=step,
        windows=windows,
        heard=supported,
        voiced=voiced,
        margin=_MARGIN_SECONDS,
        recognized=heard,
        onsets=vocal_onsets(audio, _SAMPLE_RATE, _HOP).tolist(),
    )
    guided = guide(
        align_guided(
            scores,
            step,
            words,
            windows,
            positions,
            voiced,
            whole,
            anchors={index: interval[0] for index, interval in supported.items()},
        )
    )
    started = with_voice_onsets(guided, audio)
    timed = ordered(with_sung_ends(started, audio, backing, activity))
    intervals = independent_timings(words, [heard, *views], timed) | supported
    reviewed = rate_review_indices(timed, lyrics, heard=intervals, activity=activity)
    reviewed |= boundary_conflicts(guided)
    recovered: frozenset[int] = frozenset()
    if reviewed:
        cores = guide(guided, heard=intervals, voiced=activity, reviewed=frozenset(reviewed))
        adjusted = with_voice_onsets(cores, audio)
        # Recalibrating one onset must not shift distant unchanged cores. Keep
        # jointly accepted neighbours, then recompute the affected preceding ends.
        local = [word if cores[i] != guided[i] else started[i] for i, word in enumerate(adjusted)]
        repaired = ordered(with_sung_ends(local, audio, backing, activity))
        # Guidance has already compared the local acoustic evidence. Commit the
        # accepted sequence together: restoring its old neighbour would cut it again.
        recovered = frozenset(i for i, word in enumerate(repaired) if word != timed[i])
        timed = repaired
    timed = with_sung_letters(timed, scores, step, activity, intervals)
    return alignment_payload(
        timed,
        independent_timings(words, [heard, *views], timed),
        recovered=recovered,
        reviewed=frozenset(rate_review_indices(timed, lyrics, heard=intervals, activity=activity)),
    )
