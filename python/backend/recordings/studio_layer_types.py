"""Recording-timeline plans for parallel vocals made from the performer's own voice."""

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True, slots=True)
class VocalLayerRegion:
    start: float
    end: float
    kind: Literal["double", "octave"]
    gain: float
    semitones: float = 0.0
    delay_ms: float = 0.0
    pan: float = 0.0
    modulation_ms: float = 0.0
    confidence: float = 1.0
