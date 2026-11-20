"""Pitch analysis keeps the same decisions while releasing the CPU worker GIL."""

import librosa
import numpy as np
import pytest
from scipy import stats


def test_pyin_probabilities_do_not_dispatch_python_for_every_frame(monkeypatch):
    from backend.recordings import studio_pitch_probabilities as subject

    samples = 0.1 * np.sin(2 * np.pi * 220 * np.arange(16000) / 16000)
    parameters = dict(sr=16000, fmin=50, fmax=1500, frame_length=1024, hop_length=160)
    expected = librosa.pyin(samples, **parameters)
    original, calls = subject._frame_probabilities, []

    def tracked(*args):
        calls.append(1)
        return original(*args)

    monkeypatch.setattr(subject, "_frame_probabilities", tracked)
    actual = subject.fast_pyin(librosa.pyin, samples, **parameters)
    for measured, reference in zip(actual, expected):
        np.testing.assert_array_equal(measured, reference)
    assert len(calls) == 0, "Every 10 ms frame still incurs serial Python probability dispatch"


def test_pyin_decoder_is_private_to_the_analysis_engine():
    from backend.recordings.studio_pitch_probabilities import _engine

    original_sequence = librosa.pyin.__globals__["sequence"]
    original_decoder = original_sequence.viterbi
    original_core = original_decoder.__globals__["_viterbi"]
    engine = _engine(librosa.pyin, librosa.__version__)
    assert engine.__globals__["sequence"] is not original_sequence
    assert engine.__globals__["sequence"].viterbi is not original_decoder
    assert librosa.pyin.__globals__["sequence"] is original_sequence
    assert original_sequence.viterbi is original_decoder
    assert original_decoder.__globals__["_viterbi"] is original_core


def test_compiled_pitch_kernels_release_the_gil():
    from backend.recordings import studio_pitch_kernels as kernels

    for kernel in (kernels.trough_probabilities, kernels.predecessors, kernels.decode):
        assert kernel.targetoptions["nogil"] is True
        assert not kernel.targetoptions.get("fastmath", False)


@pytest.mark.parametrize("dtype", [np.float32, np.float64])
@pytest.mark.parametrize("order", ["C", "F"])
def test_compiled_troughs_match_python_at_every_threshold(dtype, order):
    from backend.recordings.studio_pitch_probabilities import (
        _frame_probabilities,
        _yin_probabilities,
    )

    thresholds = np.linspace(0, 1, 101)
    beta = np.diff(stats.beta.cdf(thresholds, 2, 18))
    frames = np.array(
        np.random.default_rng(391).uniform(0, 1.2, (311, 51)), dtype=dtype, order=order
    )
    frames[:, 0] = 0
    frames[:, 1] = 1
    frames[:101, 2] = thresholds
    frames[0, 3], frames[-1, 3] = -0.1, -0.2
    count = len(frames) + 1
    prior = stats.boltzmann.pmf(np.arange(count)[:, None], 2, np.arange(count)[None, :])
    expected = np.zeros_like(frames)
    troughs = librosa.util.localmin(frames, axis=0)
    troughs[0] = frames[0] < frames[1]
    for index in range(frames.shape[1]):
        positions = np.flatnonzero(troughs[:, index])
        if len(positions):
            expected[positions, index] = _frame_probabilities(
                frames[positions, index], thresholds, prior, beta, 0.01
            )
    actual = _yin_probabilities(frames, thresholds, 2, beta, 0.01)
    np.testing.assert_array_equal(actual, expected)


@pytest.mark.parametrize("dtype,order", [(np.float32, "C"), (np.float64, "C"), (np.float64, "F")])
@pytest.mark.parametrize("kind", ["single", "random", "ties", "unreachable"])
def test_compact_viterbi_matches_states_and_log_probability(dtype, order, kind):
    from backend.recordings.studio_pitch_decoder import compact_viterbi

    count, steps = (7, 1) if kind == "single" else (23, 81)
    transition = librosa.sequence.transition_local(count, 5, window="triangle", wrap=False)
    transition = np.log(transition + np.finfo(dtype).tiny).astype(dtype)
    probability = np.log(np.random.default_rng(291).random((steps, count))).astype(dtype)
    if kind == "ties":
        probability[:] = 0
    if kind == "unreachable":
        probability[:, 2:7] = -np.inf
    probability = np.array(probability, order=order)
    initial = np.log(np.ones(count) / count).astype(dtype)
    threshold = float(np.log(1e-4 + np.finfo(dtype).tiny))
    reference = librosa.sequence._viterbi
    expected = reference(probability, transition, initial, threshold)
    actual = compact_viterbi(probability, transition, initial, threshold, reference=reference)
    for measured, original in zip(actual, expected):
        np.testing.assert_array_equal(measured, original)


@pytest.mark.parametrize("kind", ["full-search", "empty-predecessors", "dense", "large"])
def test_unsupported_decoder_work_uses_current_reference(kind, monkeypatch):
    from backend.recordings import studio_pitch_decoder as subject

    states = 260 if kind == "dense" else 5
    transition = np.zeros((states, states))
    probability, initial = np.ones((3, states)), np.zeros(states)
    threshold = -1.0
    if kind == "full-search":
        threshold = -np.inf
    if kind == "empty-predecessors":
        threshold = 1.0
    if kind == "large":
        monkeypatch.setattr(subject, "_MAX_STATES", 4)
    expected, calls = (np.zeros(3), np.zeros(1)), []

    def current(*args):
        calls.append(args)
        return expected

    assert (
        subject.compact_viterbi(probability, transition, initial, threshold, reference=current)
        is expected
    )
    assert len(calls) == 1 and calls[0][0] is probability


def test_changed_decoder_core_is_preserved_after_cached_engine(monkeypatch):
    from backend.recordings.studio_pitch_probabilities import _engine

    assert (
        _engine(librosa.pyin, librosa.__version__).__globals__["sequence"] is not librosa.sequence
    )
    original = librosa.sequence._viterbi

    def current(log_prob, log_trans, log_p_init, log_trans_threshold):
        return original(log_prob, log_trans, log_p_init, log_trans_threshold)

    monkeypatch.setattr(librosa.sequence, "_viterbi", current)
    assert _engine(librosa.pyin, librosa.__version__).__globals__["sequence"] is librosa.sequence
