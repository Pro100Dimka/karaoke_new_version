from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

from backend.ai.domain import PitchPoint, WordTiming
from backend.domain_errors import DependencyError
from backend.lyrics.ports import LyricLineTiming
from backend.serialization import JsonValue, dumps
from backend.songs.domain import Language


def _transcription_requests(requests: Sequence[tuple[Path, float]], end: float | None) -> bytes:
    return dumps(
        {
            "requests": [
                {
                    "input": str(audio),
                    "startSeconds": start,
                    **({"endSeconds": end} if end is not None else {}),
                }
                for audio, start in requests
            ]
        }
    ).encode("utf-8")


def _transcription_values(
    payload: dict[str, JsonValue], count: int, kind: str = "group"
) -> list[JsonValue]:
    values = payload.get("transcriptions")
    if not isinstance(values, list) or len(values) != count:
        raise DependencyError("AiProviderInvalidOutput", f"Transcription {kind} is malformed")
    return values


def _transcription_text(payload: JsonValue) -> str:
    if not isinstance(payload, dict):
        raise DependencyError("AiProviderInvalidOutput", "Transcription response is malformed")
    transcript = payload.get("text")
    if not isinstance(transcript, str):
        raise DependencyError("AiProviderInvalidOutput", "AI provider field text is invalid")
    return transcript


def _alignment_request(
    vocal: Path,
    lyrics: str,
    language: Language,
    timing_hints: Sequence[LyricLineTiming],
    instrumental: Path | None,
    asr_lyrics: bool,
    baseline_lyrics: str,
) -> list[str]:
    arguments = ["--input", str(vocal), "--language", language.value, "--lyrics", lyrics]
    if asr_lyrics:
        arguments.append("--asr-lyrics")
        if baseline_lyrics:
            arguments.extend(["--asr-baseline", baseline_lyrics])
    if instrumental is not None:
        arguments.extend(["--instrumental", str(instrumental)])
    if timing_hints:
        arguments.extend(
            [
                "--timing-hints",
                dumps([{"start": hint.start, "text": hint.text} for hint in timing_hints]),
            ]
        )
    return arguments


def _alignment_words(payload: dict[str, JsonValue]) -> tuple[WordTiming, ...]:
    values = payload.get("words")
    if not isinstance(values, list):
        raise DependencyError("AiProviderInvalidOutput", "Alignment response is malformed")
    return tuple(_word(value) for value in values)


def _word(value: JsonValue) -> WordTiming:
    if not isinstance(value, dict):
        raise DependencyError("AiProviderInvalidOutput", "Alignment item is malformed")
    start, end = _number(value, "start"), _number(value, "end")
    if start < 0 or end <= start:
        raise DependencyError("AiProviderInvalidOutput", "Alignment word has no positive duration")
    letters = value.get("letters")
    starts = (
        tuple(float(item) for item in letters if isinstance(item, int | float))
        if isinstance(letters, list)
        else ()
    )
    diagnostics = value.get("diagnostics", [])
    return WordTiming(
        _text(value, "text"),
        start,
        end,
        _number(value, "confidence"),
        starts,
        tuple(item for item in diagnostics if isinstance(item, str))
        if isinstance(diagnostics, list)
        else (),
    )


def _pitch(value: JsonValue) -> PitchPoint:
    if not isinstance(value, dict):
        raise DependencyError("AiProviderInvalidOutput", "Pitch item is malformed")
    active = value.get("audioActive")
    return PitchPoint(
        _number(value, "time"),
        _number(value, "frequency"),
        _number(value, "confidence"),
        active if isinstance(active, bool) else None,
    )


def _text(value: dict[str, JsonValue], key: str) -> str:
    item = value.get(key)
    if not isinstance(item, str) or not item:
        raise DependencyError("AiProviderInvalidOutput", f"AI provider field {key} is invalid")
    return item


def _number(value: dict[str, JsonValue], key: str) -> float:
    item = value.get(key)
    if isinstance(item, bool) or not isinstance(item, int | float):
        raise DependencyError("AiProviderInvalidOutput", f"AI provider field {key} is invalid")
    return float(item)


def _source_view(
    payload: dict[str, JsonValue], source_id: str, crop_start: float
) -> dict[str, JsonValue]:
    # Crops of the same audio are observations from one source, not extra votes.
    return {**payload, "sourceId": source_id, "cropStart": crop_start}
