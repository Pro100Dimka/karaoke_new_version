"""Keep the exact pYIN difference function while bounding FFT scratch space.

Adapted from Librosa 1.0.0 core/pitch.py.
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

from librosa import util
from librosa.core import audio
import numpy as np

_FFT_FRAMES = 128


def _difference(frames: np.ndarray, minimum: int, maximum: int) -> np.ndarray:
    correlation = audio.autocorrelate(frames, max_size=maximum + 1, axis=-2)
    # Only this prefix of cumulative energy is used by the original equation.
    difference = np.square(frames[..., : maximum + 1, :])
    np.cumsum(difference, out=difference, axis=-2)
    periods = slice(1, maximum + 1)
    difference[..., 0, :] = 0
    difference[..., periods, :] = (
        2 * (correlation[..., 0:1, :] - correlation[..., periods, :]) - difference[..., :maximum, :]
    )
    numerator = difference[..., minimum : maximum + 1, :]
    indices = util.expand_to(np.r_[periods], ndim=difference.ndim, axes=-2)
    means = np.cumsum(difference[..., periods, :], axis=-2) / indices
    denominator = means[..., minimum - 1 : maximum, :]
    return np.asarray(numerator / (denominator + util.tiny(denominator)))


def bounded_difference(
    frames: np.ndarray,
    minimum: int,
    maximum: int,
    *,
    reference: Callable[[np.ndarray, int, int], np.ndarray],
) -> np.ndarray:
    if frames.ndim < 2 or not frames.shape[-1]:
        return reference(frames, minimum, maximum)
    if frames.shape[-1] <= _FFT_FRAMES:
        return _difference(frames, minimum, maximum)
    # Frames are independent here. The complete observations are subsequently
    # decoded together; chunk boundaries, note context and confidence stay intact.
    batches = [
        _difference(frames[..., first : first + _FFT_FRAMES], minimum, maximum)
        for first in range(0, frames.shape[-1], _FFT_FRAMES)
    ]
    return np.concatenate(batches, axis=-1)
