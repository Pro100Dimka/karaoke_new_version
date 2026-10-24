from __future__ import annotations

import difflib
import threading
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from collections.abc import Mapping, Sequence
from pathlib import Path

import numpy as np
import torch
import whisper
from faster_whisper import WhisperModel
from faster_whisper.utils import download_model

from backend.ai.catalog import SPEECH_MODEL
from backend.lyrics.discovery import performed_phrases
from backend.ai_worker.audio_io import read_mono
from backend.ai_worker.ctc import (
    AlignedWord,
    Window,
    align_guided,
    align_words,
    emission,
    ordered,
    with_sung_ends,
    with_voice_onsets,
)
from backend.ai_worker.paths import model_directory, model_file
from backend.ai_worker.runtime import WHISPER_LANGUAGES, cpu_threads, device
from backend.ai_worker.timing import singing_frames, vocal_onsets, voiced_frames
from backend.ai_worker.recognition import (
    alignment_payload,
    guidance_positions,
    contextual_guidance,
    unhinted_windows,
    heard_words as _heard_words,
    serialize,
)
from backend.ai_worker.word_guidance import (
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
    target = model_directory(SPEECH_MODEL) / "ctranslate2"
    if not (target / "model.bin").is_file():
        download_model("base", output_dir=str(target))
    return {"acceleratedWhisper": str(target)}


def _transcribe(vocal: Path, language: str, prompt: str | None) -> Mapping[str, object]:
    target = device()
    model = whisper.load_model(str(model_file(SPEECH_MODEL)), device=target)
    result: Mapping[str, object] = model.transcribe(
        str(vocal),
        language=WHISPER_LANGUAGES.get(language),
        word_timestamps=True,
        initial_prompt=prompt,
        fp16=target == "cuda",
        condition_on_previous_text=False,
        temperature=0.0,
    )
    return result


def _accelerated_guidance(
    vocal: Path,
    language: str,
    prompt: str | None,
    threads: int | None = None,
    *,
    contexts: Sequence[tuple[float, float, str]] = (),
) -> Mapping[str, object]:
    """Use full precision: quantized decoding omitted sung phrases and varied with thread budget."""
    model_path = model_file(SPEECH_MODEL).parent / "ctranslate2"
    if not (model_path / "model.bin").is_file():
        raise FileNotFoundError("The accelerated Whisper model is not installed")
    model = WhisperModel(
        str(model_path),
        device="cpu",
        compute_type="float32",
        cpu_threads=threads or cpu_threads(),
        num_workers=1,
    )
    samples = read_mono(vocal, _SAMPLE_RATE)
    results = []
    requests: Sequence[tuple[float, float, str | None]] = contexts or [(0.0, 0.0, prompt)]
    for start, end, vocabulary in requests:
        segments, _ = model.transcribe(
            samples[int(start * _SAMPLE_RATE) : int(end * _SAMPLE_RATE)] if contexts else samples,
            language=WHISPER_LANGUAGES.get(language),
            word_timestamps=True,
            initial_prompt=vocabulary,
            condition_on_previous_text=False,
            beam_size=5,
            temperature=0.0,
        )
        results.append(serialize(segments, start))
    return {"contexts": results} if contexts else results[0]


def _guidance(
    vocal: Path,
    language: str,
    prompt: str | None,
    threads: int | None = None,
    *,
    prefer_accelerated: bool = False,
) -> Mapping[str, object]:
    if device() == "cuda" and not prefer_accelerated:
        return _transcribe(vocal, language, prompt)
    try:
        return _accelerated_guidance(vocal, language, prompt, threads)
    except (FileNotFoundError, OSError, RuntimeError, ValueError):
        return _transcribe(vocal, language, prompt)


def transcribe(vocal: Path, language: str) -> dict[str, str]:
    text = str(_guidance(vocal, language, None, prefer_accelerated=True).get("text", ""))
    # Recognition of singing sometimes invents symbols and numbers ("1.5%"); only words with letters are lyrics.
    return {
        "text": " ".join(
            token for token in text.split() if any(character.isalpha() for character in token)
        )
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
) -> tuple[torch.Tensor, float, list[tuple[str, float, float]]]:
    """Compute CTC and Whisper evidence in parallel, including word hints within catalogue lines."""
    threads = cpu_threads()
    if threads == 1:
        scores, frame_seconds = emission(samples)
        return (
            scores,
            frame_seconds,
            _heard_words(_guidance(vocal, language, lyrics, 1, prefer_accelerated=True)),
        )
    ctc_threads = max(1, threads // 2)
    guidance_threads = max(1, threads - ctc_threads)
    torch.set_num_threads(ctc_threads)
    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="alignment-evidence") as pool:
        ctc = pool.submit(emission, samples)
        guidance = pool.submit(
            _guidance, vocal, language, lyrics, guidance_threads, prefer_accelerated=True
        )
        scores, frame_seconds = ctc.result()
        return scores, frame_seconds, _heard_words(guidance.result())


def _heard_positions(
    words: list[str],
    heard: list[tuple[str, float, float]],
    whole: Sequence[AlignedWord] | None = None,
) -> dict[int, float]:
    """Start second of every lyric word that Whisper heard in the same order as written."""
    return {index: times[0] for index, times in _heard_timings(words, heard, whole).items()}


def _heard_timings(
    words: list[str],
    heard: list[tuple[str, float, float]],
    whole: Sequence[AlignedWord] | None = None,
    *,
    minimum_block: int = 1,
) -> dict[int, tuple[float, float]]:
    return {
        block.a + offset: (heard[block.b + offset][1], heard[block.b + offset][2])
        for block in _matching_blocks(words, heard, whole)
        if block.size >= minimum_block
        for offset in range(block.size)
    }


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
) -> list[dict[str, object]]:
    """Catalog line timings moved by the release offset the whole-song alignment reveals (if any)."""
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
    return [{"start": start + shift, "text": text} for _, start, text in lines]


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
        hints = _shifted_hints(words, timing_hints, whole)
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
) -> dict[str, list[dict[str, float | str | list[float] | list[str]]]]:
    """Align phrases, then phonetic word cores, and refine the actual sung tails."""
    samples = read_mono(vocal, _SAMPLE_RATE)
    words = lyrics.split()
    scores, frame_seconds, heard = _alignment_evidence(vocal, samples, language, lyrics)
    whole = align_words(scores, frame_seconds, words)
    heard_timings = _heard_timings(words, heard, whole)
    windows = _alignment_windows(lyrics, timing_hints, heard, whole, samples)
    backing = read_mono(instrumental, _SAMPLE_RATE) if instrumental is not None else None
    windows, supported = contextual_guidance(
        words,
        windows,
        whole,
        _heard_timings(words, heard, whole, minimum_block=_MINIMUM_BLOCK),
        singing_frames(samples, backing, _SAMPLE_RATE, _HOP),
        lambda contexts: _accelerated_guidance(vocal, language, None, contexts=contexts),
    )
    heard_timings.update(supported)
    positions = guidance_positions(heard_timings, windows)
    voiced = voiced_frames(samples, _SAMPLE_RATE, _HOP)
    guided = align_guided(scores, frame_seconds, words, windows, positions, voiced, whole)
    guided = with_word_guidance(
        guided,
        scores,
        frame_seconds,
        windows,
        supported,
        voiced,
        _MARGIN_SECONDS,
        recognized=heard,
        onsets=vocal_onsets(samples, _SAMPLE_RATE, _HOP).tolist(),
    )
    timed = ordered(with_sung_ends(with_voice_onsets(guided, samples), samples, backing))
    return alignment_payload(timed, heard_timings)
