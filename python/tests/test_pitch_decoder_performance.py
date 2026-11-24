import importlib

import librosa
import numpy as np
import pytest
import torch
import torchcrepe

pitch = importlib.import_module("backend.ai_worker.pitch")


def test_identical_pitch_evidence_produces_identical_frequencies():
    logits = torch.zeros((1, 360, 64))
    logits[:, 200] = 1

    first = pitch._viterbi_decoder(logits)
    repeated = pitch._viterbi_decoder(logits)

    assert torch.equal(first[0], repeated[0])
    assert torch.equal(first[1], repeated[1])


@pytest.mark.parametrize(
    "case", ["ambiguous_harmonic", "octave_leap", "short_step", "isolated_harmonic"]
)
def test_inference_batch_boundaries_do_not_change_the_performed_pitch(monkeypatch, case):
    first, last, base, alternative, confidence = {
        "ambiguous_harmonic": (30, 50, 0.8, 160, 0.9),
        "octave_leap": (40, 80, 0.0, 160, 1.0),
        "short_step": (35, 40, 0.1, 105, 1.0),
        "isolated_harmonic": (35, 40, 0.1, 195, 0.7),
    }[case]
    evidence = torch.zeros((80, 360))
    evidence[:, 100] = 1
    evidence[first:last, 100] = base
    evidence[first:last, alternative] = confidence

    def inference(_target):
        offset = 0

        def predict(frames):
            nonlocal offset
            result = evidence[offset : offset + len(frames)].clone()
            offset += len(frames)
            return result

        return predict

    monkeypatch.setattr(pitch, "_pitch_inference", inference)
    times = np.arange(79 * 160) / 16_000
    samples = np.sin(2 * np.pi * 220 * times).astype(np.float32)
    active = np.ones(80, dtype=bool)
    results = []
    for batch in (4, 80):
        monkeypatch.setattr(pitch, "_BATCH", {"cpu": batch})
        results.append(pitch._predict_active(samples, active, "cpu"))

    assert torch.equal(results[0][0], results[1][0])
    assert torch.equal(results[0][1], results[1][1])
    trusted = np.ones(80, dtype=bool)
    if case == "isolated_harmonic":
        trusted[first:last] = False
    assert torch.all(results[0][1][0, trusted] >= 0.8)
    assert torch.all(results[0][1][0, ~trusted] < 0.5)


def test_weak_alternative_pitch_does_not_replace_an_uncertain_decoded_frame(monkeypatch):
    evidence = torch.zeros((12, 360))
    evidence[:, 100] = 1
    evidence[4:8, 100] = 0.1
    evidence[4:8, 160] = 0.49
    monkeypatch.setattr(pitch, "_pitch_inference", lambda _: lambda frames: evidence.clone())

    _, confidence = pitch._predict_active(
        np.zeros(11 * 160, dtype=np.float32), np.ones(12, dtype=bool), "cpu"
    )

    assert torch.all(confidence[0, 4:8] < 0.5)


@pytest.mark.parametrize("frames", [1, 128, 512])
@pytest.mark.parametrize("mode", ["uniform", "random", "distant", "edge"])
@pytest.mark.parametrize("dtype", [np.float32, np.float64])
def test_banded_decoder_preserves_dense_paths_and_stable_bin_frequencies(frames, mode, dtype):
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
    assert torch.equal(
        torchcrepe.convert.frequency_to_bins(actual[1], quantize_fn=torch.round), actual[0].int()
    )
    assert torch.equal(decoder(logits)[1], actual[1])


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
