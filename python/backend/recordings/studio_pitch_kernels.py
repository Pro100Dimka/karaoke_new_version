"""Exact, GIL-free pYIN kernels with bounded probability/decoder working sets.

Adapted from Librosa 1.0.0 core/pitch.py and sequence.py.
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

from numba import njit
import numpy as np


@njit(cache=True, nogil=True)
def _threshold_weights(
    heights: np.ndarray, thresholds: np.ndarray, prior: np.ndarray
) -> np.ndarray:
    weights = np.zeros((len(heights), len(thresholds) - 1))
    for threshold in range(len(thresholds) - 1):
        count = 0
        for height in heights:
            if height < thresholds[threshold + 1]:
                count += 1
        rank = 0
        for row in range(len(heights)):
            if heights[row] < thresholds[threshold + 1]:
                weights[row, threshold] = prior[rank, count]
                rank += 1
    return weights


@njit(cache=True, nogil=True)
def trough_probabilities(
    frames: np.ndarray,
    troughs: np.ndarray,
    thresholds: np.ndarray,
    prior: np.ndarray,
    beta: np.ndarray,
    prefix: np.ndarray,
    no_trough: float,
) -> np.ndarray:
    output = np.zeros_like(frames)
    for frame in range(frames.shape[1]):
        locations = np.flatnonzero(troughs[:, frame])
        if not len(locations):
            continue
        heights = frames[locations, frame]
        # Retain BLAS dot and NumPy's prefix summation, including rounding.
        probabilities = _threshold_weights(heights, thresholds, prior).dot(beta)
        minimum = np.argmin(heights)
        absent = np.count_nonzero(~(heights[minimum] < thresholds[1:]))
        probabilities[minimum] += no_trough * prefix[absent]
        for row in range(len(locations)):
            output[locations[row], frame] = probabilities[row]
    return output


@njit(cache=True, nogil=True)
def predecessors(
    transition: np.ndarray, threshold: float, width: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    indices = np.zeros((len(transition), width), dtype=np.int32)
    weights = np.zeros((len(transition), width), dtype=np.float64)
    counts = np.zeros(len(transition), dtype=np.int32)
    for destination in range(len(transition)):
        for source in range(len(transition)):
            if transition[source, destination] >= threshold:
                position = counts[destination]
                indices[destination, position] = source
                weights[destination, position] = transition[source, destination]
                counts[destination] += 1
    return indices, weights, counts


@njit(cache=True, nogil=True)
def decode(
    probability: np.ndarray,
    indices: np.ndarray,
    weights: np.ndarray,
    counts: np.ndarray,
    initial: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    steps, states = probability.shape
    path = np.zeros(steps, dtype=np.uint16)
    value = np.zeros((2, states), dtype=np.float64)
    pointer = np.zeros((steps, states), dtype=np.uint16)
    for state in range(states):
        value[0, state] = probability[0, state] + initial[state]
    for frame in range(1, steps):
        previous, current = (frame - 1) % 2, frame % 2
        for destination in range(states):
            best = -np.inf
            for position in range(counts[destination]):
                source = indices[destination, position]
                candidate = value[previous, source] + weights[destination, position]
                # Strict comparison and ascending predecessors retain first ties.
                if candidate > best:
                    pointer[frame, destination] = source
                    best = candidate
            value[current, destination] = probability[frame, destination] + best
    path[-1] = np.argmax(value[(steps - 1) % 2])
    for frame in range(steps - 2, -1, -1):
        path[frame] = pointer[frame + 1, path[frame + 1]]
    return path, np.array([value[(steps - 1) % 2, path[-1]]])
