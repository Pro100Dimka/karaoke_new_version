"""Independent coherent-copy contexts retain ordering, evidence and cancellation."""

from dataclasses import asdict
import json
from types import SimpleNamespace
import threading

import numpy as np
import pytest
import soundfile as sf
from scipy.signal import butter, sosfilt

from backend.domain_errors import DomainError
from backend.recordings import studio_coherent_echo as echo
from backend.recordings import studio_parallel as execution
from backend.recordings.studio_regional_returns import EchoRegion


def _fixture(tmp_path, existing=False, gap=False):
    rate, seconds = 8000, 24.7
    count = round(rate * seconds)
    rng = np.random.default_rng(294)
    direct = sosfilt(
        butter(2, (500, 3000), fs=rate, btype="bandpass", output="sos"), rng.normal(0, 0.08, count)
    )
    direct *= 0.6 + 0.3 * np.sin(np.arange(count) / rate)
    copied = np.r_[np.zeros(round(rate * 0.32)), direct[: -round(rate * 0.32)]]
    dry = np.column_stack((direct, direct))
    reference = dry + copied[:, None] * np.asarray([0.6, 0.2])
    voice_path, ref_path = tmp_path / "voice.wav", tmp_path / "reference.wav"
    sf.write(voice_path, reference if existing else dry, rate, subtype="FLOAT")
    sf.write(ref_path, reference, rate, subtype="FLOAT")
    times = (np.arange(round(seconds * 4)) + 0.5) / 4
    valid = ~((times >= 9.0) & (times < 10.0)) if gap else np.ones(len(times), dtype=bool)
    arrangement = SimpleNamespace(
        duration_seconds=seconds,
        times=times,
        reference_valid=valid,
        sections=tuple(
            SimpleNamespace(start_seconds=a, end_seconds=b)
            for a, b in ((0.0, 7.0), (7.0, 19.0), (19.0, seconds))
        ),
    )
    return voice_path, ref_path, arrangement


def test_context_evidence_uses_workers_and_keeps_original_order(tmp_path, monkeypatch):
    voice, reference, arrangement = _fixture(tmp_path)
    workers = set()

    def region(_voice, _reference, start, end, validity, _cancel):
        workers.add(threading.get_ident())
        return EchoRegion(
            start, end, 0.32, 0.6, 0.2, 0.9, valid_start=validity[0], valid_end=validity[1]
        )

    monkeypatch.setattr(echo, "_region", region)
    monkeypatch.setattr(execution, "logical_cpu_count", lambda: 8)
    cancel = threading.Event()
    with execution.render_execution(cancel, workers=3):
        regions = echo.plan_coherent_echoes(voice, reference, arrangement, cancel)
    assert [(region.start, region.end) for region in regions] == [
        (0.0, 7.0),
        (7.0, 19.0),
        (19.0, 24.7),
    ]
    assert workers and threading.get_ident() not in workers


@pytest.mark.parametrize("existing,gap", [(False, False), (True, False), (False, True)])
def test_parallel_contexts_keep_exact_positive_echo_fits(tmp_path, existing, gap):
    voice, reference, arrangement = _fixture(tmp_path, existing, gap)
    cancel = threading.Event()
    with execution.render_execution(cancel, workers=1):
        expected = echo.plan_coherent_echoes(voice, reference, arrangement, cancel)
    with execution.render_execution(cancel, workers=3):
        actual = echo.plan_coherent_echoes(voice, reference, arrangement, cancel)
    assert expected
    assert json.dumps([asdict(row) for row in actual], sort_keys=True) == json.dumps(
        [asdict(row) for row in expected], sort_keys=True
    )
    assert all((row.existing_delay_seconds is not None) == existing for row in actual)


@pytest.mark.parametrize("workers", [1, 3])
def test_context_planning_preserves_cancellation(tmp_path, workers):
    voice, reference, arrangement = _fixture(tmp_path)
    cancel = threading.Event()
    with execution.render_execution(cancel, workers=workers):
        cancel.set()
        with pytest.raises(DomainError, match="cancelled"):
            echo.plan_coherent_echoes(voice, reference, arrangement, cancel)
