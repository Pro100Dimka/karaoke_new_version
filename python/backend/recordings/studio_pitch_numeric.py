"""Exact NumPy helpers for the supported Librosa pYIN path.

Adapted from Librosa 1.0.0 core/pitch.py, feature/spectral.py and util/utils.py.
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

from functools import lru_cache
from inspect import signature
import sys
from types import FunctionType, SimpleNamespace
from typing import cast

import librosa
from librosa.core import audio
from librosa.version import version as _LIBROSA_VERSION
import numpy as np

_RMS_ARGUMENTS = ("y", "S", "frame_length", "hop_length", "center", "pad_mode", "dtype")


def stock_callable(function: object, module: str, name: str, arguments: tuple[str, ...]) -> bool:
    return (
        _LIBROSA_VERSION == "1.0.0"
        and isinstance(function, FunctionType)
        and function.__module__ == module
        and function.__name__ == function.__code__.co_name == name
        and tuple(signature(function).parameters) == arguments
    )


def _loaded_rms() -> object:
    for name in ("librosa.feature", "librosa.feature.spectral"):
        module = sys.modules.get(name)
        if module is not None and "rms" in vars(module):
            return vars(module)["rms"]
    return None


def frame_rms(samples: np.ndarray, length: int, hop: int) -> np.ndarray:
    current = _loaded_rms()
    if _LIBROSA_VERSION != "1.0.0" or (
        current is not None
        and not stock_callable(current, "librosa.feature.spectral", "rms", _RMS_ARGUMENTS)
    ):
        return np.asarray(
            librosa.feature.rms(
                y=samples, frame_length=length, hop_length=hop, center=True, pad_mode="constant"
            )
        )
    librosa.util.valid_audio(samples)
    padding = [(0, 0)] * (samples.ndim - 1) + [(length // 2, length // 2)]
    padded = np.pad(samples, padding, mode="constant")
    frames = librosa.util.frame(padded, frame_length=length, hop_length=hop)
    # Librosa's RMS deliberately squares in float32 even for float64 samples.
    power = librosa.util.abs2(frames, dtype=np.float32)
    return np.sqrt(np.mean(power, axis=-2, keepdims=True))


def local_minimum(samples: np.ndarray, *, axis: int = 0) -> np.ndarray:
    reference = librosa.util.localmin
    if not stock_callable(reference, "librosa.util.utils", "localmin", ("x", "axis")):
        return np.asarray(reference(samples, axis=axis))
    values = samples.swapaxes(-1, axis)
    result = np.zeros_like(samples, dtype=bool)
    output = result.swapaxes(-1, axis)
    output[..., 1:-1] = (values[..., 1:-1] < values[..., :-2]) & (
        values[..., 1:-1] <= values[..., 2:]
    )
    output[..., -1] = values[..., -1] < values[..., -2]
    return result


def parabolic_interpolation(samples: np.ndarray, *, axis: int = -2) -> np.ndarray:
    if samples.dtype != np.dtype("float64"):
        from librosa.core import pitch

        # Other dtypes retain Librosa's history-dependent dynamic-ufunc dispatch.
        return np.asarray(pitch._parabolic_interpolation(samples, axis=axis))
    values = samples.swapaxes(-1, axis)
    result = np.zeros_like(samples)
    output = result.swapaxes(-1, axis)
    summed = values[..., 2:] + values[..., :-2]
    subtracted = values[..., 2:] - values[..., :-2]
    center = values[..., 1:-1]
    curvature, slope = summed - 2 * center, subtracted / 2
    valid = ~(np.abs(slope) >= np.abs(curvature))
    with np.errstate(divide="ignore", invalid="ignore"):
        np.divide(-slope, curvature, out=output[..., 1:-1], where=valid)
    return result


def _power(values: np.ndarray) -> np.ndarray:
    return np.square(values.real) + np.square(values.imag)


@lru_cache(maxsize=4)
def _correlator(reference: FunctionType, power: FunctionType) -> FunctionType:
    namespace = dict(reference.__globals__)
    namespace["util"] = SimpleNamespace(abs2=_power)
    function = FunctionType(
        reference.__code__,
        namespace,
        reference.__name__,
        reference.__defaults__,
        reference.__closure__,
    )
    function.__kwdefaults__ = reference.__kwdefaults__
    return function


def autocorrelation(frames: np.ndarray, maximum: int) -> np.ndarray:
    reference = audio.autocorrelate
    power = audio.util.abs2
    if frames.dtype != np.dtype("float64") or not (
        stock_callable(reference, "librosa.core.audio", "autocorrelate", ("y", "max_size", "axis"))
        and stock_callable(power, "librosa.util.utils", "abs2", ("x", "dtype"))
    ):
        return np.asarray(reference(frames, max_size=maximum, axis=-2))
    function = _correlator(cast(FunctionType, reference), cast(FunctionType, power))
    return np.asarray(function(frames, max_size=maximum, axis=-2))
