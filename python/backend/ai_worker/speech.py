from __future__ import annotations

import difflib
import threading
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from collections.abc import Mapping, Sequence
from dataclasses import replace
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
from backend.ai_worker.timing import vocal_onsets, voiced_frames

_SAMPLE_RATE = 16_000
_PROMPT_CHARACTERS = 400
_MINIMUM_BLOCK = 3
_MARGIN_SECONDS = 0.6
_HOP = 160
# A catalog line timestamp is only roughly where the line starts; when the voice clearly enters this close
# to it (earlier by up to the margin, or this much later) the line starts at that entry instead. The line
# before then ends there too, so neither can borrow a word from the other's phrase.
_ONSET_SNAP_LATER_SECONDS = 0.3
_ONSET_LEAD_SECONDS = 0.05
# Catalog timings are often made for another release of the song and run early or late as a whole (by up to
# a few seconds). The whole-song alignment reveals that shift as a steady difference between where it puts
# each line's first word and the line's timestamp; it is only applied when it is clearly more than noise.
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
    )
    return result


def _accelerated_guidance(
    vocal: Path, language: str, prompt: str | None, threads: int | None = None
) -> Mapping[str, object]:
    """Full-precision recognition for lyric coverage and independent alignment hints.

    Quantized decoding omitted performed phrases on real vocals and changed markedly with the
    thread budget. Use the same mono samples as the aligner, without quantizing the speech model.
    """
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
    segments, _ = model.transcribe(
        read_mono(vocal, _SAMPLE_RATE),
        language=WHISPER_LANGUAGES.get(language),
        word_timestamps=True,
        initial_prompt=prompt,
        condition_on_previous_text=False,
        beam_size=5,
    )
    serialized: list[dict[str, object]] = []
    text = ""
    for segment in segments:
        text += segment.text
        serialized.append(
            {
                "text": segment.text,
                "words": [
                    {"word": word.word, "start": word.start, "end": word.end}
                    for word in segment.words or []
                ],
            }
        )
    return {"text": text, "segments": serialized}


def _guidance(
    vocal: Path, language: str, prompt: str | None, threads: int | None = None,
    *, prefer_accelerated: bool = False,
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


def _key(text: str) -> str:
    return "".join(character for character in text.lower() if character.isalnum())


def _heard_words(result: Mapping[str, object]) -> list[tuple[str, float, float]]:
    heard: list[tuple[str, float, float]] = []
    segments = result.get("segments")
    for segment in segments if isinstance(segments, list) else []:
        words = segment.get("words") if isinstance(segment, dict) else None
        for word in words if isinstance(words, list) else []:
            key = _key(str(word.get("word", "")))
            if key:
                heard.append((key, float(word["start"]), float(word["end"])))
    return heard


def _matching_blocks(
    words: list[str],
    heard: list[tuple[str, float, float]],
    whole: Sequence[AlignedWord] | None = None,
) -> list[difflib.Match]:
    keys = [_key(word) for word in words]
    heard_keys = [item[0] for item in heard]
    if whole is None:
        return difflib.SequenceMatcher(a=keys, b=heard_keys, autojunk=False).get_matching_blocks()
    # Text-only longest matching blocks attach a repeated chorus to the wrong occurrence when ASR
    # misses one repeat. A monotonic match uses independent CTC starts as soft temporal evidence:
    # distant matches remain possible, while equally worded nearby repeats are preferred.
    scores = np.zeros((len(words) + 1, len(heard) + 1))
    for i in range(len(words) - 1, -1, -1):
        for j in range(len(heard) - 1, -1, -1):
            match = (
                scores[i + 1, j + 1] + 1 / (1 + abs(whole[i].start - heard[j][1]))
                if keys[i] == heard_keys[j]
                else 0.0
            )
            scores[i, j] = max(scores[i + 1, j], scores[i, j + 1], match)
    blocks: list[difflib.Match] = []
    i, j = 0, 0
    while i < len(words) and j < len(heard):
        if keys[i] == heard_keys[j] and scores[i, j] == (
            scores[i + 1, j + 1] + 1 / (1 + abs(whole[i].start - heard[j][1]))
        ):
            if blocks and blocks[-1].a + blocks[-1].size == i and blocks[-1].b + blocks[-1].size == j:
                previous = blocks[-1]
                blocks[-1] = difflib.Match(previous.a, previous.b, previous.size + 1)
            else:
                blocks.append(difflib.Match(i, j, 1))
            i, j = i + 1, j + 1
        elif scores[i + 1, j] >= scores[i, j + 1]:
            i += 1
        else:
            j += 1
    return blocks


def _windows(
    words: list[str],
    heard: list[tuple[str, float, float]],
    total: float,
    whole: Sequence[AlignedWord] | None = None,
    *, blocks: Sequence[difflib.Match] | None = None,
) -> list[Window]:
    """Splits the text into stretches whose place in the song is known from the words Whisper recognised.

    A run of at least ``_MINIMUM_BLOCK`` words heard in the same order as written pins its stretch to the time it was
    heard; the text between such runs gets the audio between them. Without any such run the whole song is one stretch.
    """
    if blocks is None:
        blocks = [block for block in _matching_blocks(words, heard, whole) if block.size >= _MINIMUM_BLOCK]
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
        windows.append(Window(
            block.a, block.a + block.size, max(start, 0.0), end, heard[block.b][1],
        ))
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
            _heard_words(_guidance(vocal, language, lyrics[:_PROMPT_CHARACTERS], 1)),
        )
    ctc_threads = max(1, threads // 2)
    guidance_threads = max(1, threads - ctc_threads)
    torch.set_num_threads(ctc_threads)
    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="alignment-evidence") as pool:
        ctc = pool.submit(emission, samples)
        guidance = pool.submit(
            _guidance, vocal, language, lyrics[:_PROMPT_CHARACTERS], guidance_threads
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
) -> dict[int, tuple[float, float]]:
    return {
        block.a + offset: (heard[block.b + offset][1], heard[block.b + offset][2])
        for block in _matching_blocks(words, heard, whole)
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
        if not (isinstance(start, (int, float)) and not isinstance(start, bool) and isinstance(text, str)):
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
        if abs(middle) >= _CATALOG_SHIFT_MINIMUM_SECONDS and spread <= _CATALOG_SHIFT_MAXIMUM_SPREAD_SECONDS:
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
    for index, (first, _, text) in enumerate(lines):
        last = first + sum(1 for word in text.split() if _key(word))
        window_start = max(0.0, opens[index][0])
        window_end = _line_end(index, lines, opens, total)
        if first > cursor:
            windows.append(Window(cursor, first, audio_cursor, max(audio_cursor, window_start)))
        windows.append(Window(first, last, window_start, window_end,
                              window_start + _ONSET_LEAD_SECONDS if opens[index][1] else None))
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
    phrases = _phrase_windows(lyrics, heard, total, whole)
    if timing_hints:
        hints = _shifted_hints(words, timing_hints, whole)
        onsets = vocal_onsets(samples, _SAMPLE_RATE, _HOP)
        windows = _hint_windows(lyrics, hints, total, onsets)
        if windows:
            recognized = {(window.first, window.last): window for window in phrases
                          if window.heard_start is not None}
            for index, window in enumerate(windows):
                phrase = recognized.get((window.first, window.last))
                # Bound CTC's search; acoustic refinement still follows held vowels beyond ASR.
                if (phrase is not None and phrase.heard_start is not None
                        and window.start <= phrase.heard_start
                        < min(window.end, window.start + 2 * _MARGIN_SECONDS)):
                    windows[index] = replace(window, start=max(window.start, phrase.start),
                                             end=min(window.end, phrase.end), heard_start=phrase.heard_start)
            return windows
    return phrases or _windows(words, heard, total, whole)


def _phrase_windows(
    lyrics: str, heard: list[tuple[str, float, float]], total: float, whole: Sequence[AlignedWord],
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
        lines, [(_key(text), start, end) for text, start, end in heard_lines],
        [whole[first] for first in firsts[:-1]],
    )
    expanded: list[tuple[str, float, float]] = []
    blocks: list[difflib.Match] = []
    for match in matches:
        for offset in range(match.size):
            text, start, end = heard_lines[match.b + offset]
            words = text.split()
            blocks.append(difflib.Match(firsts[match.a + offset], len(expanded), len(words)))
            expanded.extend((
                _key(word), start + (end - start) * i / len(words),
                start + (end - start) * (i + 1) / len(words),
            ) for i, word in enumerate(words))
    if not blocks:
        return []
    _unique_anchors(lyrics.split(), heard, blocks, expanded)
    return _windows(lyrics.split(), expanded, total, blocks=sorted(blocks, key=lambda b: b.a))


def _unique_anchors(
    words: list[str], heard: list[tuple[str, float, float]], blocks: list[difflib.Match],
    expanded: list[tuple[str, float, float]],
) -> None:
    keys = [_key(word) for word in words]
    counts, heard_counts = Counter(keys), Counter(word for word, _, _ in heard)
    occupied = {block.a + i for block in blocks for i in range(block.size)}
    positions = {word: index for index, (word, _, _) in enumerate(heard)}
    for index, key in enumerate(keys):
        if index not in occupied and counts[key] == heard_counts[key] == 1:
            candidate = heard[positions[key]]
            before = max((expanded[b.b + b.size - 1][1] for b in blocks
                          if b.a + b.size <= index), default=0.0)
            after = min((expanded[b.b][2] for b in blocks if b.a > index), default=float("inf"))
            # Unique spelling is insufficient: ASR can omit the intended occurrence and
            # recognize the same word later. An anchor must respect the surrounding phrases.
            if before <= candidate[1] <= candidate[2] <= after:
                blocks.append(difflib.Match(index, len(expanded), 1))
                expanded.append(candidate)


def _aligned_word_payload(
    word: AlignedWord, heard_timing: tuple[float, float] | None
) -> dict[str, float | str | list[float] | list[str]]:
    reasons = {
        "ApproximateAlignment": word.score <= 0.0,
        "AsrCtcBoundaryDisagreement": heard_timing is not None and max(
            abs(word.start - heard_timing[0]), abs(word.end - heard_timing[1])
        ) > _MARGIN_SECONDS,
    }
    return {
        "text": word.text,
        "start": round(word.start, 3),
        "end": round(word.end, 3),
        "confidence": word.score,
        "letters": list(word.letters),
        "diagnostics": [reason for reason, present in reasons.items() if present],
    }


def align(
    vocal: Path,
    lyrics: str,
    language: str,
    timing_hints: Sequence[Mapping[str, object]] = (),
    instrumental: Path | None = None,
) -> dict[str, list[dict[str, float | str | list[float] | list[str]]]]:
    """Timing of every word and letter of ``lyrics`` against the vocal track.

    Whisper first says roughly where each stretch of the text is sung; a character-level CTC model (forced alignment) then
    times the words and letters of every stretch inside that part of the audio only.
    """
    samples = read_mono(vocal, _SAMPLE_RATE)
    words = lyrics.split()
    scores, frame_seconds, heard = _alignment_evidence(vocal, samples, language, lyrics)
    whole = align_words(scores, frame_seconds, words)
    heard_timings = _heard_timings(words, heard, whole)
    windows = _alignment_windows(lyrics, timing_hints, heard, whole, samples)
    positions = {index: times[0] for index, times in heard_timings.items()}
    positions.update((window.first, window.heard_start) for window in windows
                     if window.heard_start is not None and window.first not in positions)
    guided = align_guided(
        scores,
        frame_seconds,
        words,
        windows,
        positions,
        voiced_frames(samples, _SAMPLE_RATE, _HOP),
        whole,
    )
    backing = read_mono(instrumental, _SAMPLE_RATE) if instrumental is not None else None
    timed = ordered(with_sung_ends(with_voice_onsets(guided, samples), samples, backing))
    return {"words": [
        _aligned_word_payload(word, heard_timings.get(index)) for index, word in enumerate(timed)
    ]}
