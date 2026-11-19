"""Map measured reference levels and actual voiced support onto the performance."""

from pathlib import Path
from collections.abc import Mapping, Sequence
import threading
from typing import Protocol

import numpy as np
import soundfile as sf

from backend.recordings.studio_audio import MasterRenderer
from backend.recordings.studio_calibration import measure_reference_body
from backend.recordings.studio_delivery import measure_mix_loudness
from backend.recordings.studio_reference import mapped_reference_times
from backend.recordings.studio_vocal_context import ReferenceBody


class ReferenceContextRender(Protocol):
    renderer: MasterRenderer
    reference_vocal: Path
    original_instrumental: Path
    vocal: Path
    cancel: threading.Event
    times: np.ndarray
    source_times: np.ndarray
    reference_level_correction_db: float | None
    reference_balance: tuple[np.ndarray, np.ndarray, np.ndarray] | None
    reference_body: ReferenceBody | None
    adjustments: Sequence[Mapping[str, object]]
    offset_result: tuple[float, float] | None
    reference_origin: float


def _performance_body(render: ReferenceContextRender, body: ReferenceBody) -> ReferenceBody:
    info = sf.info(render.vocal)
    size = max(1, round(info.samplerate * 0.02))
    times = (np.arange((info.frames + size - 1) // size) + 0.5) * 0.02
    source_times, _, _ = mapped_reference_times(
        times, render.adjustments, render.offset_result, render.reference_origin
    )
    return body.mapped(times, source_times)


def prepare_reference_context(render: ReferenceContextRender) -> None:
    vocal, music = measure_mix_loudness(
        render.renderer, render.reference_vocal, render.original_instrumental, render.cancel
    )
    axis = (np.arange(len(vocal)) + 1) * 0.1 - 0.2
    measured = [
        np.interp(render.source_times, axis, values, left=-120, right=-120)
        for values in (vocal, music)
    ]
    # Retain the original momentary trace for reporting and unsupported fallback.
    render.reference_balance = render.times, *measured
    correction = render.reference_level_correction_db
    if correction is None or not np.isfinite(correction):
        return
    body = measure_reference_body(render.reference_vocal, axis, vocal, render.cancel)
    if body is not None:
        render.reference_body = _performance_body(render, body)
