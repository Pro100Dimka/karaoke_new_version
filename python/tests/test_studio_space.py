from pathlib import Path
import threading

import numpy as np
import pytest
import soundfile as sf
from scipy.signal import fftconvolve

from backend.recordings.studio_space import SpaceProfile, analyze_space, match_space, write_impulse


def phrase_signal(rate: int = 8000) -> np.ndarray:
    rng = np.random.default_rng(42)
    samples = np.zeros(rate * 24)
    for start in range(0, 24, 3):
        phrase = rng.normal(0, 0.1, rate)
        samples[start * rate : (start + 1) * rate] = phrase
    return samples


@pytest.mark.parametrize("gain", [0.12, 0.35])
@pytest.mark.parametrize("delay", [0.12, 0.32])
def test_reference_delay_recovers_time_and_strength(tmp_path: Path, delay, gain):
    dry = phrase_signal()
    shift = round(delay * 8000)
    wet = dry.copy()
    wet[shift:] += gain * dry[:-shift]
    path = tmp_path / "reference.wav"
    sf.write(path, wet, 8000, subtype="FLOAT")
    profile = analyze_space(path, threading.Event())
    assert profile.delay_seconds == pytest.approx(delay, abs=0.005)
    assert profile.delay_gain == pytest.approx(gain, rel=0.35)


@pytest.mark.parametrize("kind", ["dry", "silence", "tone"])
def test_reference_without_effects_does_not_invent_delay(tmp_path: Path, kind):
    signal = {
        "dry": phrase_signal,
        "silence": lambda: np.zeros(8000 * 24),
        "tone": lambda: 0.1 * np.sin(2 * np.pi * 220 * np.arange(8000 * 24) / 8000),
    }[kind]()
    path = tmp_path / "reference.wav"
    sf.write(path, signal, 8000, subtype="FLOAT")
    profile = analyze_space(path, threading.Event())
    assert profile.delay_gain == 0
    assert profile.reverb_gain == 0


@pytest.mark.parametrize("decay", [0.4, 0.9])
def test_reference_reverb_estimates_decay(tmp_path: Path, decay):
    dry = phrase_signal()
    time = np.arange(round(decay * 8000)) / 8000
    impulse = np.random.default_rng(7).normal(size=len(time)) * np.exp(-6.9078 * time / decay)
    impulse /= np.linalg.norm(impulse)
    wet = dry + 0.3 * fftconvolve(dry, impulse)[: len(dry)]
    path = tmp_path / "reference.wav"
    sf.write(path, wet, 8000, subtype="FLOAT")
    profile = analyze_space(path, threading.Event())
    assert profile.decay_seconds == pytest.approx(decay, rel=0.3)
    assert 0.05 < profile.reverb_gain < 0.5


def test_matching_does_not_double_existing_room_or_delay():
    profile = SpaceProfile(delay_seconds=0.18, delay_gain=0.2, decay_seconds=0.7, reverb_gain=0.3)
    matched = match_space(profile, profile)
    assert matched.delay_gain == 0
    assert matched.reverb_gain == 0


def test_matching_does_not_add_reverb_to_a_longer_recorded_room():
    selected = match_space(
        SpaceProfile(decay_seconds=0.4, reverb_gain=0.3),
        SpaceProfile(decay_seconds=1.1, reverb_gain=0.1),
    )
    assert selected.reverb_gain == 0


def test_reference_analysis_honors_cancellation(tmp_path: Path):
    from backend.domain_errors import DomainError

    path = tmp_path / "reference.wav"
    sf.write(path, phrase_signal(), 8000, subtype="FLOAT")
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(DomainError, match="cancelled"):
        analyze_space(path, cancel)


def test_rendered_delay_keeps_direct_voice_and_exact_timing(tmp_path: Path):
    from backend.infrastructure.process_runner import ProcessRunner
    from backend.recordings.studio_master import FfmpegStudioMasterRenderer

    source, impulse, output = (tmp_path / name for name in ("source.wav", "impulse.wav", "out.wav"))
    samples = np.zeros((16000, 2))
    samples[1000] = [0.2, -0.1]
    sf.write(source, samples, 8000, subtype="FLOAT")
    write_impulse(SpaceProfile(delay_seconds=0.18, delay_gain=0.2), impulse, 8000, 2)
    FfmpegStudioMasterRenderer(ProcessRunner())._mix(
        source,
        impulse,
        "[0:a][1:a]afir=dry=1:wet=1:irnorm=-1:irgain=1,apad,atrim=end_sample=16000[out]",
        ["-c:a", "pcm_f32le", str(output)],
        threading.Event(),
    )
    rendered, rate = sf.read(output, always_2d=True)
    expected = samples.copy()
    expected[2440] += samples[1000] * 0.2
    assert rate == 8000
    np.testing.assert_allclose(rendered, expected, atol=1e-6)


def test_reference_matching_preserves_sources_and_creates_separate_output(tmp_path: Path):
    from backend.infrastructure.process_runner import ProcessRunner
    from backend.recordings.studio_master import FfmpegStudioMasterRenderer
    from backend.recordings.studio_space import apply_reference_space

    dry = phrase_signal()
    reference = dry.copy()
    reference[1600:] += 0.2 * dry[:-1600]
    voice_path, reference_path = tmp_path / "voice.wav", tmp_path / "reference.wav"
    sf.write(voice_path, dry, 8000, subtype="FLOAT")
    sf.write(reference_path, reference, 8000, subtype="FLOAT")
    originals = [path.read_bytes() for path in (voice_path, reference_path)]
    output = tmp_path / "matched.wav"
    report = apply_reference_space(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        reference_path,
        voice_path,
        voice_path,
        output,
        threading.Event(),
    )
    assert report["status"] == "matched"
    assert [path.read_bytes() for path in (voice_path, reference_path)] == originals
    rendered, rate = sf.read(output)
    assert rate == 8000
    np.testing.assert_allclose(rendered, reference, atol=0.005)


@pytest.mark.parametrize("reference_db, expected_db", [(-12, -3), (-2, -2), (12, 3)])
def test_master_balance_follows_reference_with_bounded_offset(
    tmp_path: Path, reference_db, expected_db
):
    from backend.infrastructure.process_runner import ProcessRunner
    from backend.recordings.studio_master import FfmpegStudioMasterRenderer

    rng = np.random.default_rng(12)
    voice = rng.normal(0, 0.05, 8000 * 6)
    backing = rng.normal(0, 0.05, len(voice))
    paths = {name: tmp_path / (name + ".wav") for name in ("voice", "backing", "reference", "mix")}
    for name, samples in {
        "voice": voice,
        "backing": backing,
        "reference": voice * 10 ** (reference_db / 20),
        "mix": voice + backing,
    }.items():
        sf.write(paths[name], samples, 8000, subtype="FLOAT")
    result = FfmpegStudioMasterRenderer(ProcessRunner()).render(
        paths["voice"],
        paths["backing"],
        paths["reference"],
        paths["backing"],
        tmp_path / "master.wav",
        threading.Event(),
        performance_mix=paths["mix"],
        exact_stems=True,
        process_voice=True,
        adjustments=[{"elapsedSeconds": 0, "sourceSeconds": 0, "playbackRate": 1, "keyShift": 0}],
    )
    assert result.processing["voiceBalanceTargetDb"] == pytest.approx(expected_db, abs=0.15)
    rendered, _ = sf.read(tmp_path / "master.wav")
    delivery_gain = 10 ** (result.processing["delivery"]["gainDb"] / 20)
    vocal = rendered / delivery_gain - backing
    measured = 10 * np.log10(np.mean(vocal**2) / np.mean(backing**2))
    assert measured == pytest.approx(expected_db, abs=1)
