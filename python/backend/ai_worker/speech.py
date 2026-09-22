from __future__ import annotations

import difflib
from collections.abc import Mapping
from pathlib import Path

import whisper

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
from backend.ai_worker.paths import model_file
from backend.ai_worker.runtime import WHISPER_LANGUAGES, device

_SAMPLE_RATE = 16_000
_PROMPT_CHARACTERS = 400
_MINIMUM_BLOCK = 3
_MARGIN_SECONDS = 0.6


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


def align(
    vocal: Path, lyrics: str, language: str
) -> dict[str, list[dict[str, float | str | list[float]]]]:
    """Timing of every word and letter of ``lyrics`` against the vocal track.

    Whisper first says roughly where each stretch of the text is sung; a character-level CTC model (forced alignment) then
    times the words and letters of every stretch inside that part of the audio only.
    """
    samples = read_mono(vocal, _SAMPLE_RATE)
    words = lyrics.split()
    scores, frame_seconds = emission(samples)
    total = len(samples) / _SAMPLE_RATE
    heard = _heard_words(_transcribe(vocal, language, lyrics[:_PROMPT_CHARACTERS]))
    timed = ordered(
        with_sung_ends(
            with_voice_onsets(
                align_guided(scores, frame_seconds, words, _windows(words, heard, total)), samples
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
