"""Note event decoding based on Sangeon Yong's MIT-licensed phoneme-informed transcription model.

See phoneme_model.py for the upstream copyright and license notice.
"""

from __future__ import annotations

import numpy as np
import torch
import wquantiles

from backend.ai.catalog import NOTE_MODEL
from backend.ai_worker.paths import model_file
from backend.ai_worker.phoneme_model import PhonemeNoteModel
from backend.ai_worker.timing import _levels, _runs


def melody_labels(
    samples: np.ndarray,
    frequency: torch.Tensor,
    confidence: torch.Tensor,
    active: np.ndarray,
    target: str,
) -> np.ndarray:
    if not active.any():
        return np.zeros(len(active), dtype=np.int16)
    model = PhonemeNoteModel().eval().to(target)
    checkpoint = torch.load(model_file(NOTE_MODEL), map_location="cpu", weights_only=True)
    model.load_state_dict(checkpoint["model_state_dict"], strict=True)
    with torch.inference_mode():
        prediction = model(torch.from_numpy(samples)[None].to(target))
    probabilities = prediction.sigmoid()[0].cpu().numpy()
    frequencies = frequency[0].numpy().copy()
    frequencies[(confidence[0].numpy() < 0.5) | ~active] = np.nan
    return _decode(probabilities, frequencies, _levels(samples, 160)[0])


def _peaks(scores: np.ndarray) -> list[int]:
    return [first + int(np.argmax(scores[first:last])) for first, last in _runs(scores > 0.2, True)]


def _note_offset(
    first: int,
    last: int,
    offsets: set[int],
    scores: np.ndarray,
) -> int:
    offset = last - 1
    offset_confidence = frame_confidence = 0.0
    for index in range(first + 2, last):
        if index in offsets and scores[index, 1] > offset_confidence:
            offset_confidence = float(scores[index, 1])
            offset = index
        if scores[index, 2] >= 0.5 and scores[index + 1, 2] < 0.5:
            end = index + 1
            confidence = 0.0
            while end < last and scores[end, 2] < 0.5:
                confidence = max(confidence, 1 - float(scores[end, 2]))
                end += 1
            if confidence > frame_confidence:
                frame_confidence = confidence
                offset = index
    return offset


def _decode(
    scores: np.ndarray, frequency: np.ndarray, levels: np.ndarray | None = None
) -> np.ndarray:
    labels = np.zeros(len(frequency), dtype=np.int16)
    onsets = _peaks(scores[:, 0])
    offsets = set(_peaks(scores[:, 1]))
    # The event model uses 20 ms frames; retain the existing 10 ms measured pitch grid.
    pitches = 69 + 12 * np.log2(
        frequency[np.minimum(np.arange(len(scores)) * 2, len(frequency) - 1)] / 440
    )
    for position, first in enumerate(onsets):
        last = onsets[position + 1] if position + 1 < len(onsets) else len(scores) - 1
        end = _note_offset(first, last, offsets, scores)
        values = pitches[first : end + 1]
        if end <= first or not np.isfinite(values).any():
            continue
        # A brief doubled period at the centre must not outweigh the note's majority register.
        center = float(np.nanmedian(values))
        octave = 12 * np.rint((center - values) / 12)
        values = np.where(
            (np.abs(octave) == 12) & (np.abs(values + octave - center) < 1),
            values + octave,
            values,
        )
        weights = torch.hann_window(len(values)).numpy()
        weights[~np.isfinite(values)] = 0
        if not weights.sum():
            continue
        pitch = float(wquantiles.median(values, weights / weights.sum()))
        if np.isfinite(pitch) and 0 < round(pitch) <= 127:
            labels[first * 2 : (end + 1) * 2] = round(pitch)
    for first, last in _runs(labels == 0, True):
        if not first or last == len(labels) or last - first > 20:
            continue
        heard = 69 + 12 * np.log2(frequency[first:last] / 440)
        distance = np.abs(heard[:, None] - labels[[first - 1, last]])
        if not np.isfinite(heard).all() or np.any(distance.min(axis=1) > 1.5):
            continue
        # A quiet reverberant release is not a continuing sung note.
        if (
            levels is not None
            and np.min(levels[first:last])
            < min(np.median(levels[max(0, first - 5) : first]), np.median(levels[last : last + 5]))
            - 6
        ):
            continue
        # Keep at most one transition between the existing notes, without vibrato retriggers.
        split = first + int(np.argmin(np.r_[0, np.cumsum(distance[:, 0] - distance[:, 1])]))
        labels[first:split] = labels[first - 1]
        labels[split:last] = labels[last]
    return labels
