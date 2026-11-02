import importlib

import librosa
import numpy as np
import pytest
import torch
import torchcrepe

pitch = importlib.import_module("backend.ai_worker.pitch")


@pytest.mark.parametrize("frames", [1, 128, 512])
@pytest.mark.parametrize("mode", ["uniform", "random", "distant", "edge"])
@pytest.mark.parametrize("dtype", [np.float32, np.float64])
def test_banded_decoder_preserves_dense_paths_and_frequency(frames, mode, dtype):
    rng = np.random.default_rng(851)
    values = rng.random((1, 360, frames)).astype(dtype)
    if mode == "uniform":
        values[:] = 0
    elif mode == "distant":
        values[:] = -np.inf
        values[0, np.arange(frames) % 2 * 359, np.arange(frames)] = 1
    elif mode == "edge":
        values[:] = -np.inf
        values[:, :12] = 0
    logits = torch.from_numpy(values)
    np.random.seed(275)
    expected = torchcrepe.decode.viterbi(logits)
    decoder = getattr(pitch, "_viterbi_decoder", None)
    assert callable(decoder), "Pitch still uses the dense decoder"
    np.random.seed(275)
    actual = decoder(logits)
    assert torch.equal(actual[0], expected[0])
    assert torch.equal(actual[1], expected[1])


@pytest.mark.parametrize("frames", [1, 128, 512])
def test_cpu_half_without_autocast_preserves_existing_unsupported_dtype(frames):
    logits = torch.ones((1, 360, frames), dtype=torch.float16)
    # CUDA autocast promotes softmax to float32; CPU half bypasses that promotion.
    for decoder in (torchcrepe.decode.viterbi, pitch._viterbi_decoder):
        with pytest.raises(NotImplementedError, match="float16"):
            decoder(logits)


@pytest.mark.parametrize("dtype", [np.float16, np.float32, np.float64])
def test_transition_floor_matches_librosa_for_probability_dtype(dtype):
    eps = librosa.util.tiny(np.ones((360, 8), dtype=dtype))
    actual_transition, actual_initial, actual_floor = pitch._decoder_parameters(float(eps))
    xx, yy = np.meshgrid(range(360), range(360))
    transition = np.maximum(12 - abs(xx - yy), 0)
    transition = transition / transition.sum(axis=1, keepdims=True)
    expected_transition = np.log(transition + eps)
    np.testing.assert_array_equal(actual_transition, expected_transition)
    np.testing.assert_array_equal(actual_initial, np.log(np.full(360, 1 / 360) + eps))
    assert actual_floor == expected_transition[0, -1]


def test_off_band_epsilon_transitions_are_not_pruned():
    probs = np.zeros((360, 8), dtype=np.float32)
    probs[0, :4] = 1
    probs[359, 4:] = 1
    xx, yy = np.meshgrid(range(360), range(360))
    transition = np.maximum(12 - abs(xx - yy), 0)
    transition = transition / transition.sum(axis=1, keepdims=True)
    expected, score = librosa.sequence.viterbi(probs, transition, return_logp=True)
    assert expected[0] == 0 and expected[-1] == 359
    helper = getattr(pitch, "_band_viterbi", None)
    assert callable(helper), "Exact off-band floor handling is missing"
    eps = librosa.util.tiny(probs)
    actual, actual_score = helper(
        np.log(probs + eps).T,
        np.log(transition + eps),
        np.log(np.full(360, 1 / 360) + eps),
        np.log(np.float64(eps)),
    )
    np.testing.assert_array_equal(actual, expected)
    np.testing.assert_array_equal(actual_score, score)
