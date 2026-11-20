"""Exact pitch helpers avoid first-use Librosa compilation and preserve hooks."""

from functools import wraps
import importlib
import json
from pathlib import Path
import subprocess
import sys
import textwrap

import librosa
import numpy as np
import pytest


def _exact(actual, expected):
    assert actual.shape == expected.shape
    assert actual.dtype == expected.dtype
    assert actual.tobytes(order="C") == expected.tobytes(order="C")


def test_supported_pitch_does_not_compile_librosa_gufuncs():
    script = textwrap.dedent("""
        import json, sys, threading
        import numpy as np
        from backend.recordings.studio_pitch_analysis import _estimate
        from librosa.core import pitch
        from librosa.util import utils
        sources = (pitch._pi_wrapper, utils._localmin, utils._cabs2)
        before = [list(source.types) for source in sources]
        samples = .1 * np.sin(2 * np.pi * 220 * np.arange(16000) / 16000)
        frequency, confidence, activity = _estimate(samples, threading.Event())
        print(json.dumps({
            "before": before,
            "after": [list(source.types) for source in sources],
            "voiced": int(np.count_nonzero(frequency)),
            "frames": len(activity),
            "spectralImported": "librosa.feature.spectral" in sys.modules,
        }))
    """)
    completed = subprocess.run(
        [sys.executable, "-c", script],
        cwd=Path(__file__).parents[1],
        text=True,
        capture_output=True,
        timeout=45,
        check=True,
    )
    report = json.loads(completed.stdout)
    assert report["voiced"] > 90 and report["frames"] == 101
    assert report["before"] == [[], [], []]
    assert report["after"] == [[], [], []], "Pitch still compiles three Librosa gufuncs"
    assert not report["spectralImported"], "Activity still imports the full spectral module"


@pytest.mark.parametrize("dtype", [np.float32, np.float64])
@pytest.mark.parametrize("length", [1024, 3072])
@pytest.mark.parametrize("channels", [1, 2])
def test_frame_rms_matches_librosa_float32_energy(dtype, length, channels):
    from backend.recordings.studio_pitch_numeric import frame_rms

    values = np.random.default_rng(5149).normal(0, 0.1, (channels, 160 * 71 + 31)).astype(dtype)
    values[..., 2000:5000] *= 0.001
    if channels == 1:
        values = values[0]
    expected = librosa.feature.rms(y=values, frame_length=length, hop_length=160)
    _exact(frame_rms(values, length, 160), expected)


@pytest.mark.parametrize("dtype", [np.float32, np.float64])
@pytest.mark.parametrize("order", ["C", "F", "strided"])
def test_numeric_minima_and_interpolation_keep_edges_and_rounding(dtype, order):
    from backend.recordings.studio_pitch_numeric import local_minimum, parabolic_interpolation

    pitch = importlib.import_module("librosa.core.pitch")
    values = np.random.default_rng(491).uniform(-1.2, 1.2, (311, 41)).astype(dtype)
    values[:, 0], values[:, 1] = 0, 1
    values[:, 2] = np.linspace(0, 1, len(values))
    values[:, 3] = values[::-1, 2]
    values[:, 4] = np.nextafter(dtype(0), dtype(1))
    values[1::3, 4] = 0
    values[:, 5] *= np.finfo(dtype).max / 16
    if order == "F":
        values = np.asfortranarray(values)
    elif order == "strided":
        values = values[::2, ::2]
    _exact(local_minimum(values, axis=0), librosa.util.localmin(values, axis=0))
    _exact(parabolic_interpolation(values), pitch._parabolic_interpolation(values))


@pytest.mark.parametrize("dtype", [np.float32, np.float64])
@pytest.mark.parametrize("length", [1024, 3072])
def test_autocorrelation_keeps_fft_backend_and_exact_power(dtype, length):
    from backend.recordings.studio_pitch_numeric import autocorrelation

    pitch = importlib.import_module("librosa.core.pitch")
    values = np.random.default_rng(721).normal(0, 0.1, length + 160 * 17).astype(dtype)
    frames = librosa.util.frame(values, frame_length=length, hop_length=160)
    expected = pitch.audio.autocorrelate(frames, max_size=321, axis=-2)
    _exact(autocorrelation(frames, 321), expected)


def test_wrapped_interpolation_keeps_current_callable_after_engine_cache(monkeypatch):
    from backend.recordings.studio_pitch_probabilities import _engine

    pitch = importlib.import_module("librosa.core.pitch")
    original = pitch._parabolic_interpolation
    assert _engine(librosa.pyin, librosa.__version__) is not librosa.pyin

    @wraps(original)
    def instrumented(*args, **kwargs):
        return original(*args, **kwargs)

    monkeypatch.setattr(pitch, "_parabolic_interpolation", instrumented)
    assert _engine(librosa.pyin, librosa.__version__) is librosa.pyin


@pytest.mark.parametrize("name", ["autocorrelate", "abs2"])
def test_autocorrelation_preserves_current_wrapped_callable_after_cache(monkeypatch, name):
    from backend.recordings.studio_pitch_numeric import autocorrelation

    pitch = importlib.import_module("librosa.core.pitch")
    owner = pitch.audio if name == "autocorrelate" else pitch.audio.util
    original, calls = getattr(owner, name), []
    frames = np.ones((1024, 4))
    expected = autocorrelation(frames, 321)

    @wraps(original)
    def instrumented(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(owner, name, instrumented)
    _exact(autocorrelation(frames, 321), expected)
    assert calls, f"Current {name} callable was bypassed"


def test_local_minimum_preserves_current_wrapped_callable(monkeypatch):
    from backend.recordings.studio_pitch_numeric import local_minimum

    original, calls = librosa.util.localmin, []
    values = np.arange(21, dtype=np.float64).reshape(7, 3)
    expected = original(values, axis=0)

    @wraps(original)
    def instrumented(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(librosa.util, "localmin", instrumented)
    _exact(local_minimum(values, axis=0), expected)
    assert calls


def test_activity_preserves_exposed_custom_rms(monkeypatch):
    from backend.recordings.studio_pitch_analysis import _activity

    levels = np.array([[0.0, 0.1, 0.0, 0.2]])
    calls = []

    def custom_rms(**kwargs):
        calls.append(kwargs)
        return levels

    monkeypatch.setattr(librosa.feature, "rms", custom_rms)
    np.testing.assert_array_equal(_activity(np.ones(1024)), [False, True, False, True])
    assert calls and calls[0]["frame_length"] == 1024 and calls[0]["hop_length"] == 160


def test_frame_rms_preserves_current_frame_helper(monkeypatch):
    from backend.recordings.studio_pitch_numeric import frame_rms

    original, calls = librosa.util.frame, []
    samples = np.ones(1600)
    expected = librosa.feature.rms(y=samples, frame_length=1024, hop_length=160)

    @wraps(original)
    def instrumented(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(librosa.util, "frame", instrumented)
    _exact(frame_rms(samples, 1024, 160), expected)
    assert calls, "RMS bypassed the current framing helper"


def test_activity_observes_custom_rms_power(monkeypatch):
    from backend.recordings.studio_pitch_analysis import _activity

    original, calls = librosa.util.abs2, []

    @wraps(original)
    def zero_power(*args, **kwargs):
        calls.append(1)
        return np.zeros_like(original(*args, **kwargs))

    monkeypatch.setattr(librosa.util, "abs2", zero_power)
    assert not _activity(np.ones(1600)).any(), "RMS bypassed the current power helper"
    assert calls
