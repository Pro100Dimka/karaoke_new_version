from __future__ import annotations

import numpy as np
import pytest

from backend.ai_worker.phoneme_notes import _decode
from backend.infrastructure.ai_payloads import _pitch
from backend.domain_errors import DependencyError


@pytest.mark.parametrize("missing", ["nnAudio", "wquantiles"])
def test_local_provider_requires_the_note_model_runtime_dependencies(monkeypatch, missing):
    from backend.bootstrap import ai_wiring

    monkeypatch.setattr(
        ai_wiring.importlib.util, "find_spec", lambda name: None if name == missing else object()
    )
    assert not ai_wiring._worker_libraries_installed()


def test_note_events_use_sung_offsets_and_ignore_unpitched_reverb():
    scores = np.zeros((101, 3), dtype=np.float32)
    scores[:, 2] = 0.9
    scores[[10, 50], 0] = 0.9
    scores[[40, 90], 1] = 0.9
    frequency = np.r_[np.full(100, 440.0), np.full(102, 523.25)]
    frequency[82:100] = np.nan
    labels = _decode(scores, frequency)
    assert np.array_equal(labels[20:82], np.full(62, 69))
    assert np.array_equal(labels[100:182], np.full(82, 72))
    assert not labels[:20].any()
    assert not labels[82:100].any()
    assert not labels[182:].any()
    assert not _decode(scores, np.full(202, np.nan)).any()


def test_a_note_at_the_file_start_is_not_lost_and_activation_can_end_it():
    scores = np.zeros((51, 3), dtype=np.float32)
    scores[0, 0] = 0.9
    scores[:30, 2] = 0.9
    labels = _decode(scores, np.full(102, 440.0))
    assert np.array_equal(labels[:60], np.full(60, 69))
    assert not labels[60:].any()


@pytest.mark.parametrize("pitch", [46, 58, 70])
@pytest.mark.parametrize("octave", [-12, 12])
def test_a_brief_central_octave_outlier_does_not_relabel_the_whole_note(pitch, octave):
    scores = np.zeros((15, 3), dtype=np.float32)
    scores[:, 2] = 0.9
    scores[0, 0] = scores[13, 1] = 0.9
    measured = np.full(14, float(pitch))
    measured[4:9] += octave
    frequency = np.repeat(440 * 2 ** ((measured - 69) / 12), 2)

    assert np.array_equal(_decode(scores, frequency), np.full(28, pitch))


def test_separate_sung_octaves_keep_their_own_register():
    scores = np.zeros((30, 3), dtype=np.float32)
    scores[:, 2] = 0.9
    scores[[0, 15], 0] = 0.9
    scores[[13, 28], 1] = 0.9
    frequency = np.repeat(440 * 2 ** ((np.r_[np.full(15, 58), np.full(15, 46)] - 69) / 12), 2)

    labels = _decode(scores, frequency)

    assert np.array_equal(labels[:28], np.full(28, 58))
    assert np.array_equal(labels[30:58], np.full(28, 46))


@pytest.mark.parametrize("continuation", ["held", "breath", "different_pitch"])
def test_equal_notes_only_join_through_the_same_continuing_voice(continuation):
    scores = np.zeros((31, 3), dtype=np.float32)
    scores[:, 2] = 0.9
    scores[[0, 18], 0] = 0.9
    scores[[9, 29], 1] = 0.9
    frequency = np.full(62, 220.0)
    frequency[20:36] = {"held": 220.0, "breath": np.nan, "different_pitch": 261.63}[continuation]

    labels = _decode(scores, frequency)

    assert np.array_equal(labels[:20], np.full(20, 57))
    assert np.array_equal(labels[20:36], np.full(16, 57 if continuation == "held" else 0))
    assert np.array_equal(labels[36:60], np.full(24, 57))
    assert not labels[60:].any()


def test_a_quiet_reverberant_gap_does_not_join_two_repeated_notes():
    scores = np.zeros((31, 3), dtype=np.float32)
    scores[:, 2] = 0.9
    scores[[0, 18], 0] = 0.9
    scores[[9, 29], 1] = 0.9
    frequency = np.full(62, 220.0)
    levels = np.zeros(62)
    levels[20:36] = -20

    labels = _decode(scores, frequency, levels)

    assert not labels[20:36].any()
    assert np.array_equal(labels[:20], np.full(20, 57))
    assert np.array_equal(labels[36:60], np.full(24, 57))


def test_a_continuous_pitch_change_does_not_create_a_gap_between_sung_notes():
    scores = np.zeros((31, 3), dtype=np.float32)
    scores[:, 2] = 0.9
    scores[[0, 18], 0] = 0.9
    scores[[9, 29], 1] = 0.9
    pitches = np.r_[np.full(20, 57), np.linspace(57, 59, 16), np.full(26, 59)]
    frequency = 440 * 2 ** ((pitches - 69) / 12)

    labels = _decode(scores, frequency, np.zeros(62))

    assert labels[20:36].min() == 57
    assert labels[20:36].max() == 59
    assert (np.diff(labels[20:36]) >= 0).all()
    assert np.array_equal(labels[:20], np.full(20, 57))
    assert np.array_equal(labels[36:60], np.full(24, 59))


@pytest.mark.parametrize("value", [True, -1, 128, 69.5, "69"])
def test_provider_rejects_malformed_musical_note_labels(value):
    with pytest.raises(DependencyError, match="Musical note is malformed"):
        _pitch({"time": 0, "frequency": 440, "confidence": 1, "melodyNote": value})
