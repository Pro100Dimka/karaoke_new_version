from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from hashlib import sha256
from pathlib import Path

import numpy as np

from backend.ai_worker.speech_windows import _SAMPLE_RATE
from backend.text_normalization import clean_lyrics


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
