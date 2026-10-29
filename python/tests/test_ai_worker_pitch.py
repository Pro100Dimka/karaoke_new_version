from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import torch

from backend.ai_worker.pitch import _pitch_points


@pytest.mark.parametrize("rate", [44100, 48000])
@pytest.mark.parametrize("level", [0.1, 0.001])
def test_model_input_preserves_channel_only_and_opposite_polarity_phrases(tmp_path, rate, level):
    import librosa
    import soundfile as sf
    from backend.ai_worker.audio_io import read_mono

    time = np.arange(rate) / rate
    voice = (
        level * np.sin(2 * np.pi * 220 * time) * np.minimum(1, np.minimum(time, 1 - time) * 100)
    ).astype(np.float32)
    silence = np.zeros_like(voice)
    stereo = np.stack(
        [np.concatenate((voice, silence, voice)), np.concatenate((silence, voice, -voice))], axis=1
    )
    path = tmp_path / "phrases.wav"
    sf.write(path, stereo, rate, subtype="FLOAT")

    samples = read_mono(path, 16000)

    expected = librosa.resample(voice, orig_sr=rate, target_sr=16000)
    assert samples.dtype == np.float32
    assert len(samples) == 48000
    for index in range(3):
        phrase = samples[index * 16000 + 160 : (index + 1) * 16000 - 160]
        np.testing.assert_allclose(
            abs(np.dot(phrase, expected[160:-160]))
            / np.dot(expected[160:-160], expected[160:-160]),
            1,
            atol=0.01,
        )
    assert np.max(abs(np.diff(samples))) < level * 0.15, "routing must not add a boundary click"
    np.testing.assert_array_equal(sf.read(path, dtype="float32")[0], stereo)


@pytest.mark.parametrize("rate", [44100, 48000])
@pytest.mark.parametrize("weaker", [0.25, 0.5, 0.75])
@pytest.mark.parametrize("level", [0.1, 0.001])
def test_model_input_does_not_hold_a_quieter_channel_during_cancellation(
    tmp_path, rate, weaker, level
):
    import soundfile as sf
    from backend.ai_worker.audio_io import read_mono

    voice = (level * np.sin(np.arange(rate) * 2 * np.pi * 220 / rate)).astype(np.float32)
    stereo = np.stack(
        (
            np.concatenate((voice, weaker * voice, voice)),
            np.concatenate((-weaker * voice, -voice, -weaker * voice)),
        ),
        axis=1,
    )
    path = tmp_path / "unequal-channels.wav"
    sf.write(path, stereo, rate, subtype="FLOAT")
    mono = read_mono(path, 16000)
    for phrase in np.split(mono, 3):
        np.testing.assert_allclose(
            np.sqrt(np.mean(phrase[160:-160] ** 2)), level / np.sqrt(2), rtol=0.01
        )
    assert np.max(abs(np.diff(mono))) < level * 0.15


@pytest.mark.parametrize("frames", [0, 1, 73, 48000 + 73])
def test_model_input_keeps_clean_mono_and_coherent_stereo_unchanged(tmp_path, frames):
    import soundfile as sf
    from backend.ai_worker.audio_io import read_mono

    voice = (0.1 * np.sin(np.arange(frames) * 2 * np.pi * 220 / 48000)).astype(np.float32)
    for samples in (voice, np.stack((voice, voice), axis=1)):
        path = tmp_path / "clean.wav"
        sf.write(path, samples, 48000, subtype="FLOAT")
        np.testing.assert_array_equal(read_mono(path, 48000), voice)


def test_model_input_resamples_empty_audio_without_creating_samples(tmp_path):
    import soundfile as sf
    from backend.ai_worker.audio_io import read_mono

    path = tmp_path / "empty.wav"
    sf.write(path, np.empty((0, 2), dtype=np.float32), 48000, subtype="FLOAT")
    assert read_mono(path, 16000).shape == (0,)


@pytest.mark.parametrize("rate", [44100, 48000])
@pytest.mark.parametrize("level", [0.1, 0.001])
def test_safe_stereo_phrase_keeps_its_native_polarity_after_channel_routing(tmp_path, rate, level):
    import soundfile as sf
    from backend.ai_worker.audio_io import read_mono

    voice = (level * np.sin(np.arange(rate) * 2 * np.pi * 220 / rate)).astype(np.float32)
    stereo = np.stack(
        (
            np.concatenate((voice * 0.2, voice, voice)),
            np.concatenate((-voice, -voice * 0.2, voice)),
        ),
        axis=1,
    )
    path = tmp_path / "routed-then-coherent.wav"
    sf.write(path, stereo, rate, subtype="FLOAT")

    mono = read_mono(path, rate)

    np.testing.assert_array_equal(mono[2 * rate + rate // 100 :], voice[rate // 100 :])
    assert np.max(abs(np.diff(mono))) < level * 0.15
    np.testing.assert_array_equal(sf.read(path, dtype="float32")[0], stereo)


class _Vector:
    def __init__(self, values: list[float]) -> None:
        self.values = values
        self.cpu_calls = 0

    def __getitem__(self, index: int) -> "_Vector":
        assert index == 0
        return self

    def detach(self) -> "_Vector":
        return self

    def cpu(self) -> "_Vector":
        self.cpu_calls += 1
        return self

    def tolist(self) -> list[float]:
        return self.values


def test_pitch_points_transfer_each_result_to_cpu_only_once() -> None:
    frequency = _Vector([440.125, 441.875])
    periodicity = _Vector([0.91234, 0.87654])

    points = _pitch_points(frequency, periodicity, step=0.01)

    assert frequency.cpu_calls == 1
    assert periodicity.cpu_calls == 1
    assert points == [
        {"time": 0.0, "frequency": 440.12, "confidence": 0.912},
        {"time": 0.01, "frequency": 441.88, "confidence": 0.877},
    ]


@pytest.mark.parametrize("length", [0, 1, 16000 * 12 + 73])
def test_inaudible_pitch_skips_the_network_but_keeps_the_timeline(monkeypatch, length):
    from backend.ai_worker import pitch as worker

    calls = []
    monkeypatch.setattr(worker, "device", lambda: "cpu")
    monkeypatch.setattr(worker, "read_mono", lambda *_: np.zeros(length, dtype=np.float32))
    monkeypatch.setattr(
        worker.torchcrepe,
        "infer",
        lambda frames, *args, **kwargs: calls.append(len(frames)) or torch.ones((len(frames), 360)),
    )

    points = worker.pitch(Path("silent.wav"))["points"]

    assert calls == [], "inaudible audio must not spend time in the full pitch network"
    assert len(points) == 1 + length // 160
    assert [point["time"] for point in points] == [round(i * 0.01, 3) for i in range(len(points))]
    assert all(point["frequency"] == point["confidence"] == 0 for point in points)
    assert not any(point["audioActive"] for point in points)


@pytest.mark.parametrize("batch", [128, 512])
def test_skipping_silent_pitch_batches_keeps_quiet_entries_and_decoder_context(monkeypatch, batch):
    from backend.ai_worker import pitch as worker

    samples = np.zeros(160 * (batch * 5 + 9) + 73, dtype=np.float32)
    first, last = 160 * (batch * 2 - 2), 160 * (batch * 2 + 3)
    samples[first:last] = 0.002 * np.sin(np.arange(last - first) * 2 * np.pi * 220 / 16000)
    inferred = []
    monkeypatch.setattr(worker, "device", lambda: "cpu")
    monkeypatch.setattr(worker, "_BATCH", {"cpu": batch})
    monkeypatch.setattr(worker, "read_mono", lambda *_: samples)

    def infer(frames, *args, **kwargs):
        inferred.append(frames.clone())
        return torch.ones((len(frames), 360))

    monkeypatch.setattr(worker.torchcrepe, "infer", infer)
    monkeypatch.setattr(
        worker.torchcrepe,
        "postprocess",
        lambda probabilities, *args, **kwargs: (
            torch.full((1, probabilities.shape[-1]), 220.0),
            torch.full((1, probabilities.shape[-1]), 0.9),
        ),
    )
    expected = list(
        worker.torchcrepe.preprocess(torch.from_numpy(samples)[None], 16000, 160, batch)
    )

    points = worker.pitch(Path("quiet-entry.wav"))["points"]

    assert len(inferred) == 2, "only the two batches around this quiet entry need inference"
    for actual, original in zip(inferred, expected[1:3], strict=True):
        torch.testing.assert_close(actual, original, rtol=0, atol=0)
    active = [point for point in points if point["audioActive"]]
    assert active
    assert all(point["frequency"] == 220.0 and point["confidence"] == 0.9 for point in active)
    assert len(points) == 1 + len(samples) // 160
