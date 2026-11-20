"""Reuse immutable pYIN transitions across chunks without touching Librosa."""

from concurrent.futures import ThreadPoolExecutor
from functools import wraps
import threading

import librosa
import numpy as np


def test_pitch_chunks_build_the_same_local_transition_only_once(monkeypatch):
    from backend.recordings.studio_pitch_probabilities import _engine

    expected = librosa.sequence.transition_local(17, 5, window="triangle", wrap=False)
    original, calls = librosa.sequence.get_window, []

    def tracked(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(librosa.sequence, "get_window", tracked)
    private = _engine(librosa.pyin, librosa.__version__).__globals__["sequence"]
    first = private.transition_local(17, 5, window="triangle", wrap=False)
    second = private.transition_local(17, 5, window="triangle", wrap=False)
    np.testing.assert_array_equal(first, expected)
    np.testing.assert_array_equal(second, expected)
    assert len(calls) == 17, "The same 17 windows are rebuilt for each pitch chunk"
    assert first is second and not first.flags.writeable


def test_concurrent_first_transition_build_is_single(monkeypatch):
    from backend.recordings.studio_pitch_probabilities import _engine

    private = _engine(librosa.pyin, librosa.__version__).__globals__["sequence"]
    original, calls = librosa.sequence.get_window, []
    start = threading.Barrier(4)

    def tracked(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)

    def build(_):
        start.wait(timeout=2)
        return private.transition_local(37, 5, window="triangle", wrap=False)

    monkeypatch.setattr(librosa.sequence, "get_window", tracked)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(build, range(4)))
    assert len(calls) == 37
    assert all(value is results[0] for value in results)


def test_transition_cache_has_bounded_entries_and_state_dimension(monkeypatch):
    from backend.recordings import studio_pitch_transitions as subject

    reference = librosa.sequence.transition_local
    subject._local.cache_clear()
    for states in range(4, 10):
        subject.transition_local(states, 3, reference=reference)
    assert subject._local.cache_info().currsize == 4
    monkeypatch.setattr(subject, "_MAX_STATES", 3)
    before = subject._local.cache_info()
    first = subject.transition_local(7, 3, reference=reference)
    second = subject.transition_local(7, 3, reference=reference)
    assert first is not second and first.flags.writeable
    np.testing.assert_array_equal(first, second)
    assert subject._local.cache_info() == before


def test_array_widths_and_probability_vectors_keep_reference_behavior():
    from backend.recordings.studio_pitch_probabilities import _engine

    private = _engine(librosa.pyin, librosa.__version__).__globals__["sequence"]
    widths = np.array([1, 2, 3, 3, 1])
    actual = private.transition_local(5, widths, window="ones", wrap=False)
    np.testing.assert_array_equal(
        actual, librosa.sequence.transition_local(5, widths, window="ones", wrap=False)
    )
    probability = np.array([0.8, 0.5, 0.25])
    np.testing.assert_array_equal(
        private.transition_loop(3, probability), librosa.sequence.transition_loop(3, probability)
    )


def test_wrapped_transition_is_preserved_after_cached_engine(monkeypatch):
    from backend.recordings.studio_pitch_probabilities import _engine

    original, calls = librosa.sequence.transition_local, []
    _engine(librosa.pyin, librosa.__version__)

    @wraps(original)
    def instrumented(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(librosa.sequence, "transition_local", instrumented)
    private = _engine(librosa.pyin, librosa.__version__).__globals__["sequence"]
    private.transition_local(19, 5, window="triangle", wrap=False)
    private.transition_local(19, 5, window="triangle", wrap=False)
    assert len(calls) == 2


def test_unhashable_transition_callable_keeps_original_namespace(monkeypatch):
    from backend.recordings.studio_pitch_probabilities import _engine

    original = librosa.sequence.transition_local

    class Instrumented:
        __hash__ = None

        def __call__(self, *args, **kwargs):
            return original(*args, **kwargs)

    monkeypatch.setattr(librosa.sequence, "transition_local", Instrumented())
    private = _engine(librosa.pyin, librosa.__version__).__globals__["sequence"]
    assert private is librosa.sequence


def test_repeated_voicing_transition_is_immutable():
    from backend.recordings.studio_pitch_probabilities import _engine

    private = _engine(librosa.pyin, librosa.__version__).__globals__["sequence"]
    first, second = private.transition_loop(2, 0.99), private.transition_loop(2, 0.99)
    np.testing.assert_array_equal(first, librosa.sequence.transition_loop(2, 0.99))
    assert first is second and not first.flags.writeable
