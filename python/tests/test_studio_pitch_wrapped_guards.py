"""Metadata-preserving wrappers retain their current pYIN implementation."""

from functools import wraps
import importlib

import librosa
import pytest

from backend.recordings.studio_pitch_probabilities import _engine


@pytest.mark.parametrize("name", ["__pyin_helper", "_cumulative_mean_normalized_difference"])
def test_wrapped_pitch_helpers_keep_current_callable_after_cached_engine(monkeypatch, name):
    pitch = importlib.import_module("librosa.core.pitch")
    original = getattr(pitch, name)
    assert _engine(librosa.pyin, librosa.__version__) is not librosa.pyin

    @wraps(original)
    def instrumented(*args, **kwargs):
        return original(*args, **kwargs)

    monkeypatch.setattr(pitch, name, instrumented)
    assert _engine(librosa.pyin, librosa.__version__) is librosa.pyin


def _assert_private_decoder_enabled():
    private = _engine(librosa.pyin, librosa.__version__).__globals__["sequence"]
    assert private is not librosa.sequence


def test_wrapped_decoder_dispatcher_keeps_current_callable_after_cached_engine(monkeypatch):
    original = librosa.sequence._viterbi
    _assert_private_decoder_enabled()

    @wraps(original)
    def instrumented(*args, **kwargs):
        return original(*args, **kwargs)

    # functools.wraps copies the dispatcher's py_func metadata into the wrapper.
    assert instrumented.py_func is original.py_func
    monkeypatch.setattr(librosa.sequence, "_viterbi", instrumented)
    private = _engine(librosa.pyin, librosa.__version__).__globals__["sequence"]
    assert private is librosa.sequence


def test_wrapped_decoder_source_keeps_current_callable_after_cached_engine(monkeypatch):
    original = librosa.sequence._viterbi
    _assert_private_decoder_enabled()

    @wraps(original.py_func)
    def instrumented_source(*args, **kwargs):
        return original.py_func(*args, **kwargs)

    class InstrumentedCore:
        def __init__(self):
            self.py_func = instrumented_source
            self.__code__ = instrumented_source.__code__

        def __call__(self, *args, **kwargs):
            return self.py_func(*args, **kwargs)

    monkeypatch.setattr(librosa.sequence, "_viterbi", InstrumentedCore())
    private = _engine(librosa.pyin, librosa.__version__).__globals__["sequence"]
    assert private is librosa.sequence
