from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path

import whisper

from backend.ai.catalog import SPEECH_MODEL
from backend.ai_worker.audio_io import read_mono
from backend.ai_worker.ctc import align_words, emission, with_sung_ends, with_voice_onsets
from backend.ai_worker.paths import model_file
from backend.ai_worker.runtime import WHISPER_LANGUAGES, device

_SAMPLE_RATE = 16_000


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


def align(vocal: Path, lyrics: str) -> dict[str, list[dict[str, float | str | list[float]]]]:
    """Timing of every word and letter of ``lyrics`` against the vocal track (forced alignment with a character CTC model)."""
    samples = read_mono(vocal, _SAMPLE_RATE)
    words = lyrics.split()
    scores, frame_seconds = emission(samples)
    timed = with_sung_ends(
        with_voice_onsets(align_words(scores, frame_seconds, words), samples), samples
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
