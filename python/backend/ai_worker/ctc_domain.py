from __future__ import annotations
from dataclasses import dataclass


_CHUNK_SECONDS = 20.0
_CONTEXT_SECONDS = 2.0
_MINIMUM_WORD_SECONDS = 0.05
# A word is over once the voice has been silent this long; the model often keeps its last letter "sounding"
# through the pause until the next word, which would keep the word lit over silence.
_SILENCE_ENDS_WORD_SECONDS = 0.3
_PREFERENCE = 0.05
# Whisper's word times are coarse (a few tenths of a second), but they reliably tell which sung phrase a
# word belongs to. Two placements of a stretch that differ by more than this against them are not jitter.
_HEARD_DISAGREEMENT_SECONDS = 0.25
_SILENT_START_SECONDS = 0.06
_CRAMMED_WORD_SECONDS = 0.08
_PAUSE_SECONDS = 0.25
# The model marks a letter only "a little" after its sound begins (see with_voice_onsets below); a wider
# window than this risks locking onto a nearer but unrelated voiced region -- a breath, backing vocal, or
# the previous word's tail -- and moving a word by far more than any such lag ever really is.
_ONSET_SEARCH_BEFORE_SECONDS = 0.25
_ONSET_SEARCH_AFTER_SECONDS = 0.1
_LARGEST_LAG_SECONDS = 0.3
_VOICE_RATE = 16_000
_VOICE_HOP = 160


@dataclass(frozen=True, slots=True)
class AlignedWord:
    text: str
    start: float
    end: float
    letters: tuple[float, ...]
    # Mean probability the model gave the word's letters where they were placed (0 when it had nothing to pronounce).
    score: float = 0.0
    # Keep destructive normalization visible to acoustic review and the saved report.
    diagnostics: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class Window:
    """Words ``first`` up to ``last`` (exclusive) are sung between the times ``start`` and ``end`` (seconds)."""

    first: int
    last: int
    start: float
    end: float
    heard_start: float | None = None
