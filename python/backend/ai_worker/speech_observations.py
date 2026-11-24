from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from hashlib import sha256
from math import isfinite
from pathlib import Path
import re

import numpy as np
from faster_whisper.vad import get_vad_model

from backend.ai_worker.speech_windows import _HOP, _SAMPLE_RATE
from backend.ai_worker.timing import _ABSOLUTE_FLOOR_DB, _levels
from backend.text_normalization import clean_lyrics


def discard_silent_segments(
    result: Mapping[str, object], samples: np.ndarray
) -> Mapping[str, object]:
    segments, text = result.get("segments"), result.get("text")
    if not isinstance(segments, list) or not isinstance(text, str):
        return result
    lines = [
        segment
        for segment in segments
        if isinstance(segment, dict) and isinstance(segment.get("text"), str)
    ]
    if (
        len(lines) != len(segments)
        or "".join(segment["text"] for segment in lines).split() != text.split()
    ):
        return result
    levels, _ = _levels(samples, _HOP)
    audible = levels >= _ABSOLUTE_FLOOR_DB
    retained = [segment for segment in lines if _touches_audible_audio(segment, audible)]
    credits = [
        segment
        for segment in retained
        if re.match(r"\s*(?:субтитры|субтитри|subtitles?)\b", segment["text"], re.IGNORECASE)
    ]
    if credits:
        speech = get_vad_model()(np.pad(samples, (0, -len(samples) % 512))).reshape(-1) >= 0.5
        retained = [
            segment
            for segment in retained
            if segment not in credits or _touches_audible_audio(segment, speech, _SAMPLE_RATE / 512)
        ]
    if len(retained) == len(lines):
        return result
    return dict(result, segments=retained, text="".join(segment["text"] for segment in retained))


def _touches_audible_audio(
    segment: Mapping[str, object],
    audible: np.ndarray,
    frames_per_second: float = _SAMPLE_RATE / _HOP,
) -> bool:
    start, end = segment.get("start"), segment.get("end")
    if (
        not isinstance(start, int | float)
        or not isinstance(end, int | float)
        or not (isfinite(start) and isfinite(end) and 0 <= start < end)
    ):
        return True
    # Allow timing jitter around the segment and keep quiet vocals above the absolute floor.
    first = round(max(0.0, start - 0.2) * frames_per_second)
    last = round((end + 0.2) * frames_per_second) + 1
    return bool(audible[first:last].any())


def recognition_views(recognition: Mapping[str, object] | None) -> list[Mapping[str, object]]:
    if recognition is None:
        return []
    alternatives = recognition.get("alternatives", [])
    return (
        [recognition, *(view for view in alternatives if isinstance(view, dict))]
        if isinstance(alternatives, list)
        else [recognition]
    )


@dataclass(slots=True)
class RecognitionObservations:
    samples: np.ndarray
    language: str
    recognition: Mapping[str, object] | None
    views: list[Mapping[str, object]] = field(default_factory=list)

    def record(self, source: Path | np.ndarray, transcript: Mapping[str, object]) -> None:
        samples = self.samples if isinstance(source, Path) else source
        self.views.append(
            {
                "text": clean_lyrics(str(transcript.get("text", "")), self.language),
                "segments": transcript.get("segments", []),
                "sourceId": self._source_id(samples),
                "cropStart": 0.0,
                "cropEnd": len(samples) / _SAMPLE_RATE,
            }
        )

    def _source_id(self, samples: np.ndarray) -> str:
        source = self.recognition.get("sourceId") if self.recognition is not None else None
        if isinstance(source, str) and source and np.array_equal(samples, self.samples):
            return source
        # Identify the waveform actually decoded. A reconstructed mix is not the
        # original file, and adding silent backing does not create another source.
        pcm = np.ascontiguousarray(samples, dtype="<f4")
        return f"pcm:{_SAMPLE_RATE}:" + sha256(memoryview(pcm)).hexdigest()
