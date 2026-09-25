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
    Window,
    align_guided,
    emission,
    ordered,
    with_sung_ends,
    with_voice_onsets,
)
from backend.ai_worker.paths import model_directory, model_file
from backend.ai_worker.runtime import WHISPER_LANGUAGES, cpu_threads, device

_SAMPLE_RATE = 16_000
_PROMPT_CHARACTERS = 400
_MINIMUM_BLOCK = 3
_MARGIN_SECONDS = 0.6


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
    timing_hints: Sequence[Mapping[str, object]] = (),
) -> tuple[torch.Tensor, float, list[tuple[str, float, float]]]:
    """Computes independent CTC emissions and Whisper guidance in parallel."""
    threads = cpu_threads()
    if timing_hints:
        torch.set_num_threads(threads)
        scores, frame_seconds = emission(samples)
        return scores, frame_seconds, []
    if threads == 1:
        scores, frame_seconds = emission(samples)
        return scores, frame_seconds, _heard_words(
            _guidance(vocal, language, lyrics[:_PROMPT_CHARACTERS], 1)
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


def _hint_windows(
    lyrics: str, hints: Sequence[Mapping[str, object]], total: float
) -> list[Window]:
    words = lyrics.split()
    keys = [_key(word) for word in words]
    valid: list[tuple[float, str]] = []
    for item in hints:
        start, text = item.get("start"), item.get("text")
        if isinstance(start, (int, float)) and not isinstance(start, bool) and isinstance(text, str):
            valid.append((float(start), text))
    windows: list[Window] = []
    cursor, audio_cursor, matched = 0, 0.0, 0
    for index, (start, text) in enumerate(valid):
        end = valid[index + 1][0] if index + 1 < len(valid) else total
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
        window_start, window_end = max(0.0, start - _MARGIN_SECONDS), min(
            total, end + _MARGIN_SECONDS
        )
        if first > cursor:
            windows.append(Window(cursor, first, audio_cursor, max(audio_cursor, window_start)))
        last = first + len(line)
        windows.append(Window(first, last, window_start, window_end))
        cursor, audio_cursor, matched = last, window_end, matched + len(line)
    if cursor < len(words):
        windows.append(Window(cursor, len(words), audio_cursor, total))
    return windows if matched >= _MINIMUM_BLOCK else []


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
    total = len(samples) / _SAMPLE_RATE
    windows = _hint_windows(lyrics, timing_hints, total) if timing_hints else []
    scores, frame_seconds, heard = _alignment_evidence(
        vocal, samples, language, lyrics, timing_hints if windows else ()
    )
    if not windows:
        windows = _windows(words, heard, total)
    timed = ordered(
        with_sung_ends(
            with_voice_onsets(
                align_guided(scores, frame_seconds, words, windows), samples
            ),
            samples,
        )
    )
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
