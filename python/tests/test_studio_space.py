from pathlib import Path
import threading

import numpy as np
import pytest
import soundfile as sf
from scipy.signal import fftconvolve

from backend.recordings.studio_space import SpaceProfile, analyze_space, match_space


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
    from backend.recordings.studio_space import _render_separate_buses

    _render_separate_buses(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        source,
        output,
        threading.Event(),
        SpaceProfile(delay_seconds=0.18, delay_gain=0.2),
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


@pytest.mark.parametrize(
    "reference_db, expected_db, varying_effect",
    [(-80, -1, False), (-12, -1, False), (-2, -1, False), (6, -1, False), (-2, -1, True)],
)
def test_master_balance_uses_backing_independently_of_reference_level(
    tmp_path: Path, monkeypatch, reference_db, expected_db, varying_effect
):
    from backend.infrastructure.process_runner import ProcessRunner
    from backend.recordings.studio_master import FfmpegStudioMasterRenderer
    import shutil

    def preserve_backing(backing, voice, target, active, cancel, **reference):
        shutil.copyfile(backing, target)
        return {}

    # Isolate vocal balance so subtracting the backing recovers only the voice.
    monkeypatch.setattr(
        FfmpegStudioMasterRenderer, "_unmask_backing", staticmethod(preserve_backing)
    )
    if varying_effect:

        def spatial_energy(renderer, reference, recorded, voice, target, cancel, *, full_reference):
            assert full_reference == paths["reference"]
            samples, rate = sf.read(voice)
            samples[: len(samples) // 2] *= 2
            samples[len(samples) // 2 :] *= 4
            sf.write(target, samples, rate, subtype="FLOAT")
            return {}

        monkeypatch.setattr(
            "backend.recordings.studio_render.apply_reference_space", spatial_energy
        )

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
    rendered, _ = sf.read(tmp_path / "master.wav")
    delivery_gain = 10 ** (result.processing["delivery"]["gainDb"] / 20)
    vocal = rendered / delivery_gain - backing
    measured = 10 * np.log10(np.mean(vocal**2) / np.mean(backing**2))
    assert measured == pytest.approx(expected_db, abs=1)
    assert (
        result.processing["postMixCalibration"]["method"]
        == "perceptual-and-spectral-backing-balance"
    )
    if varying_effect:
        for section in (slice(8000, 16000), slice(32000, 40000)):
            level = 10 * np.log10(np.mean(vocal[section] ** 2) / np.mean(backing[section] ** 2))
            assert level == pytest.approx(expected_db, abs=1)


@pytest.mark.parametrize("dark,seconds", [(True, 4), (False, 4), (True, 1)])
def test_master_clarity_only_corrects_supported_dark_voice(tmp_path, dark, seconds):
    from scipy.signal import butter, sosfilt
    from backend.recordings.studio_audio import _profile
    from backend.recordings.studio_dynamics import _voice_filters

    rate = 22050
    samples = np.random.default_rng(91).normal(0, 0.05, rate * seconds)
    if dark:
        samples = sosfilt(butter(2, 1800, fs=rate, output="sos"), samples)
    samples[: rate // 2] = 0
    path = tmp_path / "voice.wav"
    sf.write(path, samples, rate, subtype="FLOAT")
    original = path.read_bytes()
    filters, report = _voice_filters(path, _profile(path, threading.Event()), threading.Event())
    if dark and seconds >= 3:
        assert 0.5 < report["clarityAmount"] <= 1
    else:
        assert report["clarityAmount"] == 0
    assert any(item.startswith("treble=") for item in filters) == (dark and seconds >= 3)
    assert path.read_bytes() == original


def test_master_preserves_performed_backing_dynamics(tmp_path, monkeypatch):
    from backend.recordings.studio_render import MasterRender
    from backend.recordings.studio_master import FfmpegStudioMasterRenderer
    from backend.infrastructure.process_runner import ProcessRunner

    rate = 8000
    original = np.repeat([-24.0, -30.0, -24.0], 100)
    recorded = original + np.repeat([-3.0, -9.0, -3.0], 100)
    time = np.arange(rate * 30) / rate
    tone = np.sin(2 * np.pi * 440 * time)
    music = tone * np.repeat(10 ** (recorded / 20) * np.sqrt(2), rate // 10)
    reference = tone * np.repeat(10 ** (original / 20) * np.sqrt(2), rate // 10)
    voice = 0.02 * np.sin(2 * np.pi * 880 * time)
    paths = {name: tmp_path / f"{name}.wav" for name in ("voice", "music", "original", "mix")}
    for name, samples in [
        ("voice", voice),
        ("music", music),
        ("original", reference),
        ("mix", music + voice),
    ]:
        sf.write(paths[name], samples, rate, subtype="FLOAT")
    initial = paths["music"].read_bytes()
    calibrate = MasterRender._calibrate
    observed = []

    def capture(render):
        calibrate(render)
        observed.append(sf.read(render.backing)[0])

    monkeypatch.setattr(MasterRender, "_calibrate", capture)
    FfmpegStudioMasterRenderer(ProcessRunner()).render(
        paths["voice"],
        paths["music"],
        paths["voice"],
        paths["original"],
        tmp_path / "master.wav",
        threading.Event(),
        performance_mix=paths["mix"],
        exact_stems=True,
        process_voice=False,
        adjustments=[{"elapsedSeconds": 0, "sourceSeconds": 0, "playbackRate": 1, "keyShift": 0}],
    )
    for index in (5, 15, 25):
        level = 10 * np.log10(np.mean(observed[0][index * rate : (index + 1) * rate] ** 2))
        assert level == pytest.approx(recorded[index * 10], abs=1.6)
    assert paths["music"].read_bytes() == initial


@pytest.mark.parametrize("reference_ratio,amount", [(-16.0, 1.5), (-24.0, 0.0)])
def test_master_clarity_follows_reference_without_brightening_past_it(reference_ratio, amount):
    from backend.recordings.studio_dynamics import _clarity_filters

    filters = []
    assert _clarity_filters([-20.0] * 40, filters, reference_ratio) == amount
    if amount:
        assert filters[0].endswith("g=-1.500000")
        assert filters[-1].endswith("g=3.000000")
    else:
        assert not filters


def test_master_clarity_limits_broad_treble_boost():
    from backend.recordings.studio_dynamics import _clarity_filters

    filters = []
    _clarity_filters([-25.0] * 40, filters, -10.0)
    treble = next(item for item in filters if item.startswith("treble="))
    assert float(treble.split("g=")[-1]) <= 3.0


def test_master_body_correction_does_not_require_treble_boost():
    from backend.recordings.studio_dynamics import _clarity_filters

    filters = []
    assert _clarity_filters([-20.0] * 40, filters, -24.0, 2.5) == 0
    assert len(filters) == 1
    assert filters[0].endswith("g=-2.500000")


def test_master_body_correction_follows_measured_coloration(tmp_path):
    from scipy.signal import butter, sosfilt
    from backend.recordings.studio_audio import _profile
    from backend.recordings.studio_dynamics import _voice_filters

    rate = 22050
    noise = np.random.default_rng(87).normal(0, 0.04, rate * 6)
    reference = sosfilt(butter(2, 3500, fs=rate, output="sos"), noise)
    colored = reference + 4 * sosfilt(
        butter(2, [350, 700], btype="bandpass", fs=rate, output="sos"), reference
    )
    reference[:rate] = colored[:rate] = 0
    original, voice = tmp_path / "reference.wav", tmp_path / "voice.wav"
    sf.write(original, reference, rate, subtype="FLOAT")
    sf.write(voice, colored, rate, subtype="FLOAT")
    cancel = threading.Event()
    filters, _ = _voice_filters(voice, _profile(voice, cancel), cancel, original)
    cuts = [item for item in filters if item.startswith("equalizer=") and ":g=-" in item]
    assert any(350 <= float(item.split(":")[0].split("=")[-1]) <= 700 for item in cuts)


def test_master_air_correction_does_not_boost_upper_midrange():
    from backend.recordings.studio_dynamics import _clarity_filters

    filters = []
    _clarity_filters([-25.0] * 40, filters, -10.0)
    assert not any(item.startswith("equalizer=f=2800:") for item in filters)
