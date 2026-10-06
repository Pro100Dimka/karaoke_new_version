from __future__ import annotations

import difflib
from concurrent.futures import ThreadPoolExecutor
from collections.abc import Mapping, Sequence
from pathlib import Path

import numpy as np
import torch
import whisper
from faster_whisper import WhisperModel
from faster_whisper.utils import download_model

from backend.ai.catalog import SPEECH_MODEL
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
    """Word timestamps from CTranslate2 for alignment hints. The exact lyric transcription still uses
    the original Whisper model. Alignment only needs rough
    word windows, so its independent hint can use the substantially faster int8 CPU engine while the
    MMS model uses the admitted accelerator (or the other half of the CPU budget).
    """
    model_path = model_file(SPEECH_MODEL).parent / "ctranslate2"
    if not (model_path / "model.bin").is_file():
        raise FileNotFoundError("The accelerated Whisper model is not installed")
    model = WhisperModel(
        str(model_path),
        device="cpu",
        compute_type="int8",
        cpu_threads=threads or cpu_threads(),
        num_workers=1,
    )
    segments, _ = model.transcribe(
        str(vocal),
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
    vocal: Path, language: str, prompt: str | None, threads: int | None = None
) -> Mapping[str, object]:
    if device() == "cuda":
        return _transcribe(vocal, language, prompt)
    try:
        return _accelerated_guidance(vocal, language, prompt, threads)
    except (FileNotFoundError, OSError, RuntimeError, ValueError):
        return _transcribe(vocal, language, prompt)


def transcribe(vocal: Path, language: str) -> dict[str, str]:
    text = str(_transcribe(vocal, language, None).get("text", ""))
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


def _windows(words: list[str], heard: list[tuple[str, float, float]], total: float) -> list[Window]:
    """Splits the text into stretches whose place in the song is known from the words Whisper recognised.

    A run of at least ``_MINIMUM_BLOCK`` words heard in the same order as written pins its stretch to the time it was
    heard; the text between such runs gets the audio between them. Without any such run the whole song is one stretch.
    """
    matcher = difflib.SequenceMatcher(
        a=[_key(word) for word in words], b=[item[0] for item in heard], autojunk=False
    )
    blocks = [block for block in matcher.get_matching_blocks() if block.size >= _MINIMUM_BLOCK]
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
        windows.append(Window(block.a, block.a + block.size, max(start, 0.0), end))
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
    """Computes independent CTC emissions and Whisper guidance in parallel.

    Whisper runs even when catalog line timings exist: those only place whole lines, while the words Whisper
    heard settle which of two neighbouring sung phrases a word belongs to (see ctc.align_guided).
    """
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


def _heard_positions(words: list[str], heard: list[tuple[str, float, float]]) -> dict[int, float]:
    """Start second of every lyric word that Whisper heard in the same order as written."""
    matcher = difflib.SequenceMatcher(
        a=[_key(word) for word in words], b=[item[0] for item in heard], autojunk=False
    )
    return {
        block.a + offset: heard[block.b + offset][1]
        for block in matcher.get_matching_blocks()
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
        windows.append(Window(first, last, window_start, window_end))
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
    words = lyrics.split()
    total = len(samples) / _SAMPLE_RATE
    if timing_hints:
        hints = _shifted_hints(words, timing_hints, whole)
        onsets = vocal_onsets(samples, _SAMPLE_RATE, _HOP)
        windows = _hint_windows(lyrics, hints, total, onsets)
        if windows:
            return windows
    return _windows(words, heard, total)


def align(
    vocal: Path,
    lyrics: str,
    language: str,
    timing_hints: Sequence[Mapping[str, object]] = (),
) -> dict[str, list[dict[str, float | str | list[float]]]]:
    """Timing of every word and letter of ``lyrics`` against the vocal track.

    Whisper first says roughly where each stretch of the text is sung; a character-level CTC model (forced alignment) then
    times the words and letters of every stretch inside that part of the audio only.
    """
    samples = read_mono(vocal, _SAMPLE_RATE)
    words = lyrics.split()
    scores, frame_seconds, heard = _alignment_evidence(vocal, samples, language, lyrics)
    whole = align_words(scores, frame_seconds, words)
    guided = align_guided(
        scores,
        frame_seconds,
        words,
        _alignment_windows(lyrics, timing_hints, heard, whole, samples),
        _heard_positions(words, heard),
        voiced_frames(samples, _SAMPLE_RATE, _HOP),
        whole,
    )
    timed = ordered(with_sung_ends(with_voice_onsets(guided, samples), samples))
    return {
        "words": [
            {
                "text": word.text,
                "start": round(word.start, 3),
                "end": round(word.end, 3),
                "confidence": 1.0,
                "letters": list(word.letters),
            }
            for word in timed
        ]
    }
