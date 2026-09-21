from __future__ import annotations

import difflib
import re
from collections.abc import Mapping
from pathlib import Path

import whisper

from backend.ai.catalog import SPEECH_MODEL
from backend.ai_worker.paths import model_file
from backend.ai_worker.runtime import WHISPER_LANGUAGES, device

_WORD = re.compile(r"[^\W_]+", re.UNICODE)
_PROMPT_CHARACTERS = 400
_MINIMUM_STEP_SECONDS = 0.05

Timing = tuple[float, float, float]
HeardWord = tuple[str, float, float, float]


def _key(text: str) -> str:
    return "".join(_WORD.findall(text)).lower()


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
    return {"text": str(_transcribe(vocal, language, None).get("text", "")).strip()}


def _heard_words(result: Mapping[str, object]) -> list[HeardWord]:
    heard: list[HeardWord] = []
    segments = result.get("segments")
    for segment in segments if isinstance(segments, list) else []:
        words = segment.get("words") if isinstance(segment, dict) else None
        for word in words if isinstance(words, list) else []:
            key = _key(str(word.get("word", "")))
            if key:
                heard.append(
                    (
                        key,
                        float(word["start"]),
                        float(word["end"]),
                        float(word.get("probability", 0.5)),
                    )
                )
    return heard


def align(vocal: Path, lyrics: str, language: str) -> dict[str, list[dict[str, float | str]]]:
    """Timing for every word of ``lyrics``: heard words are matched to the text, the rest are interpolated."""
    heard = _heard_words(_transcribe(vocal, language, lyrics[:_PROMPT_CHARACTERS]))
    if not heard:
        raise ValueError("No speech was found in the vocal track")
    written = lyrics.split()
    matcher = difflib.SequenceMatcher(
        a=[_key(item) for item in written], b=[item[0] for item in heard], autojunk=False
    )
    timings: dict[int, Timing] = {}
    for block in matcher.get_matching_blocks():
        for offset in range(block.size):
            _, start, end, probability = heard[block.b + offset]
            timings[block.a + offset] = (start, end, probability)
    return {
        "words": _with_gaps_filled(written, timings, max(item[2] for item in heard), heard[0][1])
    }


def _with_gaps_filled(
    written: list[str], timings: dict[int, Timing], total: float, first_start: float
) -> list[dict[str, float | str]]:
    result: list[dict[str, float | str]] = []
    cursor = first_start
    for index, text in enumerate(written):
        if index in timings:
            start, end, confidence = timings[index]
        else:
            next_known = next((i for i in range(index + 1, len(written)) if i in timings), None)
            following = timings[next_known][0] if next_known is not None else total
            unknown = (next_known if next_known is not None else len(written)) - index
            step = max(_MINIMUM_STEP_SECONDS, (following - cursor) / unknown)
            start, end, confidence = cursor, cursor + step, 0.0
        start = max(start, cursor)
        end = max(end, start + _MINIMUM_STEP_SECONDS)
        result.append(
            {
                "text": text,
                "start": round(start, 3),
                "end": round(end, 3),
                "confidence": round(confidence, 3),
            }
        )
        cursor = end
    return result
