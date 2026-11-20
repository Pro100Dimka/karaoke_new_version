"""Reuse exact pYIN priors without changing Librosa's decoding or library globals.

The probability helper is adapted from Librosa 1.0.0, core/pitch.py.
Copyright (c) 2013--2026, librosa development team. ISC License:
Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.
THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
"""

from collections.abc import Callable
from functools import lru_cache, partial
from inspect import signature
from types import CodeType, FunctionType
from typing import cast

import librosa
from librosa.version import version as _LIBROSA_VERSION
import numpy as np
from scipy import stats

from backend.recordings.studio_pitch_decoder import isolate_decoder
from backend.recordings.studio_pitch_difference import bounded_difference
from backend.recordings.studio_pitch_kernels import trough_probabilities

PitchResult = tuple[np.ndarray, np.ndarray, np.ndarray]
_MAX_PERIODS = 512
_DIFFERENCE_NAME = "_cumulative_mean_normalized_difference"
_DIFFERENCE_ARGUMENTS = ("y_frames", "min_period", "max_period")
_HELPER_ARGUMENTS = (
    "yin_frames",
    "parabolic_shifts",
    "sr",
    "thresholds",
    "boltzmann_parameter",
    "beta_probs",
    "no_trough_prob",
    "min_period",
    "fmin",
    "n_pitch_bins",
    "n_bins_per_semitone",
)
_PYIN_ARGUMENTS = (
    "y",
    "fmin",
    "fmax",
    "sr",
    "frame_length",
    "hop_length",
    "n_thresholds",
    "beta_parameters",
    "boltzmann_parameter",
    "resolution",
    "max_transition_rate",
    "switch_prob",
    "no_trough_prob",
    "fill_na",
    "center",
    "pad_mode",
    "transition_min_prob",
)


def _uses_helper(code: CodeType) -> bool:
    return "__pyin_helper" in code.co_names or any(
        _uses_helper(item) for item in code.co_consts if isinstance(item, CodeType)
    )


def _compatible(function: Callable[..., PitchResult], version: str) -> bool:
    if version != "1.0.0" or not isinstance(function, FunctionType):
        return False
    helper = function.__globals__.get("__pyin_helper")
    difference = function.__globals__.get(_DIFFERENCE_NAME)
    return (
        _uses_helper(function.__code__)
        and isinstance(helper, FunctionType)
        and helper.__code__.co_name == "__pyin_helper"
        and tuple(signature(function).parameters) == _PYIN_ARGUMENTS
        and tuple(signature(helper).parameters) == _HELPER_ARGUMENTS
        and isinstance(difference, FunctionType)
        and difference.__module__ == "librosa.core.pitch"
        and difference.__name__ == _DIFFERENCE_NAME
        and difference.__code__.co_name == _DIFFERENCE_NAME
        and tuple(signature(difference).parameters) == _DIFFERENCE_ARGUMENTS
    )


def _engine(function: Callable[..., PitchResult], version: str) -> Callable[..., PitchResult]:
    if not _compatible(function, version):
        return function
    source = cast(FunctionType, function)
    return isolate_decoder(
        _clone(source, source.__globals__["__pyin_helper"], source.__globals__[_DIFFERENCE_NAME])
    )


@lru_cache(maxsize=4)
def _clone(function: FunctionType, helper: FunctionType, difference: FunctionType) -> FunctionType:
    namespace = dict(function.__globals__)
    namespace["__pyin_helper"] = partial(_helper, reference=helper)
    namespace[_DIFFERENCE_NAME] = partial(bounded_difference, reference=difference)
    engine = FunctionType(
        function.__code__, namespace, function.__name__, function.__defaults__, function.__closure__
    )
    engine.__kwdefaults__ = function.__kwdefaults__
    return engine


def fast_pyin(
    function: Callable[..., PitchResult], samples: np.ndarray, **parameters: object
) -> PitchResult:
    """Retain the unmodified current callable when its private ABI is unsupported."""
    return _engine(function, _LIBROSA_VERSION)(samples, **parameters)


def _frame_probabilities(
    heights: np.ndarray,
    thresholds: np.ndarray,
    prior: np.ndarray,
    beta: np.ndarray,
    no_trough: float,
) -> np.ndarray:
    below = np.less.outer(heights, thresholds[1:])
    positions = np.cumsum(below, axis=0) - 1
    counts = np.count_nonzero(below, axis=0)
    weights = prior[positions, counts]
    # Positions -1 and counts 0 are ineligible, exactly as in the upstream PMF.
    weights[~below] = 0
    probabilities = weights.dot(beta)
    minimum = np.argmin(heights)
    absent = np.count_nonzero(~below[minimum, :])
    probabilities[minimum] += no_trough * np.sum(beta[:absent])
    return np.asarray(probabilities)


def _yin_probabilities(
    frames: np.ndarray,
    thresholds: np.ndarray,
    boltzmann: float,
    beta: np.ndarray,
    no_trough: float,
) -> np.ndarray:
    troughs = librosa.util.localmin(frames, axis=0)
    troughs[0] = frames[0] < frames[1]
    count = len(frames) + 1
    prior = stats.boltzmann.pmf(np.arange(count)[:, None], boltzmann, np.arange(count)[None, :])
    prefix = np.asarray([np.sum(beta[:end]) for end in range(len(beta) + 1)])
    return np.asarray(
        trough_probabilities(frames, troughs, thresholds, prior, beta, prefix, no_trough)
    )


def _observations(
    probabilities: np.ndarray,
    shifts: np.ndarray,
    sr: float,
    min_period: int,
    fmin: float,
    pitch_bins: int,
    bins_per_semitone: int,
) -> tuple[np.ndarray, np.ndarray]:
    period, frame = np.nonzero(probabilities)
    candidates = min_period + period
    candidates = candidates + shifts[period, frame]
    frequencies = sr / candidates
    bins = 12 * bins_per_semitone * np.log2(frequencies / fmin)
    bins = np.clip(np.round(bins), 0, pitch_bins).astype(int)
    observations = np.zeros((2 * pitch_bins, probabilities.shape[1]))
    observations[bins, frame] = probabilities[period, frame]
    voiced = np.clip(np.sum(observations[:pitch_bins, :], axis=0, keepdims=True), 0, 1)
    observations[pitch_bins:, :] = (1 - voiced) / pitch_bins
    return observations[np.newaxis], voiced


def _helper(
    yin_frames: np.ndarray,
    parabolic_shifts: np.ndarray,
    sr: float,
    thresholds: np.ndarray,
    boltzmann_parameter: float,
    beta_probs: np.ndarray,
    no_trough_prob: float,
    min_period: int,
    fmin: float,
    n_pitch_bins: int,
    n_bins_per_semitone: int,
    *,
    reference: Callable[..., tuple[np.ndarray, np.ndarray]],
) -> tuple[np.ndarray, np.ndarray]:
    if not 2 <= len(yin_frames) <= _MAX_PERIODS:
        return reference(
            yin_frames,
            parabolic_shifts,
            sr,
            thresholds,
            boltzmann_parameter,
            beta_probs,
            no_trough_prob,
            min_period,
            fmin,
            n_pitch_bins,
            n_bins_per_semitone,
        )
    probabilities = _yin_probabilities(
        yin_frames, thresholds, boltzmann_parameter, beta_probs, no_trough_prob
    )
    return _observations(
        probabilities, parabolic_shifts, sr, min_period, fmin, n_pitch_bins, n_bins_per_semitone
    )
