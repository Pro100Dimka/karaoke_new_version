"""Reference balance must not turn quiet accompaniment into a vocal gain surge."""

from pathlib import Path
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_audio import _write_gain_envelope
from backend.recordings.studio_calibration import build_gain_plan
from backend.recordings.studio_delivery import measure_mix_loudness
from backend.recordings.studio_master import FfmpegStudioMasterRenderer


def _render_gain_plan(
    root: Path, voice: np.ndarray, music: np.ndarray, reference_voice: np.ndarray | None
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    rate = 8000
    vocal, backing, reference, output = (
        root / f"{name}.wav" for name in ("voice", "backing", "reference", "output")
    )
    sf.write(vocal, voice, rate, subtype="FLOAT")
    sf.write(backing, music, rate, subtype="FLOAT")
    renderer = FfmpegStudioMasterRenderer(ProcessRunner())
    cancel = threading.Event()
    reference_balance = None
    if reference_voice is not None:
        sf.write(reference, reference_voice, rate, subtype="FLOAT")
        ref_voice, ref_music = measure_mix_loudness(renderer, reference, backing, cancel)
        meter_times = (np.arange(len(ref_voice)) + 1) * 0.1 - 0.2
        times = (np.arange(len(ref_voice)) + 0.5) * 0.1
        reference_balance = (
            times,
            *(
                np.interp(times, meter_times, levels, left=-120, right=-120)
                for levels in (ref_voice, ref_music)
            ),
        )
    plan = build_gain_plan(
        renderer, vocal, backing, 0.5, cancel, reference_balance=reference_balance
    )
    _write_gain_envelope(vocal, output, plan.times, plan.gains, cancel)
    actual, actual_rate = sf.read(output)
    assert actual_rate == rate and actual.shape == voice.shape
    assert np.isfinite(actual).all()
    return actual, plan.times, plan.gains


@pytest.mark.parametrize("with_reference", [False, True])
@pytest.mark.parametrize("pause_gain", [0.0, 0.001, 0.015, 0.03])
def test_near_silent_backing_does_not_raise_a_steady_voice_twice(
    tmp_path, with_reference, pause_gain
):
    rate = 8000
    times = np.arange(rate * 30) / rate
    voice = 0.05 * np.sin(2 * np.pi * 700 * times)
    music = 0.05 * np.sin(2 * np.pi * 900 * times)
    music[(times >= 10) & (times < 20)] *= pause_gain
    actual, _, _ = _render_gain_plan(tmp_path, voice, music, voice if with_reference else None)

    steady = np.mean(actual[(times >= 3) & (times < 7)] ** 2)
    quiet = np.mean(actual[(times >= 13) & (times < 17)] ** 2)
    # The singer is unchanged and the accompaniment is held through its quiet gap.
    # A reference describing the same gap must not compensate that silence a second time.
    assert abs(10 * np.log10(quiet / steady)) < 3
    # The partially filled meter windows at the gap boundaries must not create
    # a shorter gain surge after the sustained quiet section has been protected.
    body = actual[(times >= 3) & (times < 27)]
    assert np.max(np.abs(body)) < np.sqrt(2 * steady) * 10 ** (3 / 20)
    assert np.max(np.abs(actual)) < 0.15


def test_reference_still_supports_positive_phrase_placement_with_audible_backing(tmp_path):
    rate = 8000
    times = np.arange(rate * 30) / rate
    voice = 0.05 * np.sin(2 * np.pi * 700 * times)
    music = 0.05 * np.sin(2 * np.pi * 900 * times)
    reference = voice.copy()
    reference[(times >= 10) & (times < 20)] *= 10 ** (8 / 20)
    _, positions, gains = _render_gain_plan(tmp_path, voice, music, reference)

    initial = np.median(gains[(positions > 3) & (positions < 7)])
    emphasis = np.median(gains[(positions > 13) & (positions < 17)])
    assert emphasis - initial == pytest.approx(8, abs=0.3)
