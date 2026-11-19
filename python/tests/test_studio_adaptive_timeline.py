from pathlib import Path
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.domain_errors import DependencyError
from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_master import FfmpegStudioMasterRenderer


def test_partial_take_uses_only_performed_reference_and_keeps_sample_boundaries(tmp_path: Path):
    from backend.recordings.studio_sources import render_timeline

    rate = 8000
    time = np.arange(rate * 4) / rate
    samples = 0.1 * np.sin(2 * np.pi * np.where(time < 2, 330, 660) * time)
    source, target = tmp_path / "reference.wav", tmp_path / "performed.wav"
    sf.write(source, samples, rate, subtype="FLOAT")
    frames = 13001
    points = [
        {"elapsedSeconds": 0, "sourceSeconds": 0.25, "playbackRate": 1, "keyShift": 0},
        {"elapsedSeconds": 0.33333, "sourceSeconds": 2.1, "playbackRate": 1, "keyShift": 0},
    ]
    render_timeline(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        source,
        target,
        threading.Event(),
        points,
        frames=frames,
        rate=rate,
        channels=1,
    )
    actual, _ = sf.read(target)
    assert len(actual) == frames
    boundary = round(points[1]["elapsedSeconds"] * rate)
    np.testing.assert_allclose(actual[:boundary], samples[2000 : 2000 + boundary], atol=1e-7)
    np.testing.assert_allclose(
        actual[boundary:], samples[16800 : 16800 + frames - boundary], atol=1e-7
    )


@pytest.mark.parametrize(
    "adjustments",
    [
        [{}],
        [
            {"elapsedSeconds": 0, "sourceSeconds": 0, "playbackRate": 1, "keyShift": 0},
            {"elapsedSeconds": 0, "sourceSeconds": 2, "playbackRate": 1, "keyShift": 0},
        ],
    ],
)
def test_invalid_timeline_never_silently_masters_wrong_song_section(tmp_path, adjustments):
    from backend.recordings.studio_sources import render_timeline

    source = tmp_path / "source.wav"
    sf.write(source, np.zeros(8000), 8000)
    with pytest.raises(DependencyError, match="timeline"):
        render_timeline(
            FfmpegStudioMasterRenderer(ProcessRunner()),
            source,
            tmp_path / "out.wav",
            threading.Event(),
            adjustments,
            frames=8000,
            rate=8000,
            channels=1,
        )


def _phrases(rate=8000):
    rng = np.random.default_rng(9)
    signal = np.zeros(rate * 25)
    for index, onset in enumerate([1.01, 3.72, 7.06, 10.45, 14.23, 18.62, 22.09]):
        length = round((0.6 + rng.uniform(0, 0.6)) * rate)
        t = np.arange(length) / rate
        envelope = np.minimum(1, t / 0.03) * np.minimum(1, (t[-1] - t) / 0.13)
        envelope *= 0.8 + 0.2 * np.sin(2 * np.pi * (2 + index / 3) * t)
        start = round(onset * rate)
        signal[start : start + length] = (
            0.08 * envelope * np.sin(2 * np.pi * (180 + 17 * index) * t)
        )
    return signal


def test_timing_moves_only_confirmed_consistent_phrase_delay(tmp_path):
    from backend.recordings.studio_adaptive_timing import align_voice

    rate = 8000
    reference = _phrases(rate)
    delay = 80 * rate // 1000
    # Different singer: invert polarity and alter spectrum, keep phrase timing.
    performance = np.r_[np.zeros(delay), -reference[:-delay]]
    paths = [tmp_path / name for name in ["voice.wav", "reference.wav", "aligned.wav"]]
    sf.write(paths[0], performance, rate, subtype="FLOAT")
    sf.write(paths[1], reference, rate, subtype="FLOAT")
    report = align_voice(paths[0], paths[1], paths[2], threading.Event())
    aligned, _ = sf.read(paths[2])
    assert abs(report["shiftMs"] + 80) <= 10
    assert len(aligned) == len(reference)
    np.testing.assert_allclose(aligned[rate:-rate], -reference[rate:-rate], atol=1e-7)


def test_timing_retains_unrelated_or_insufficient_phrases(tmp_path):
    from backend.recordings.studio_adaptive_timing import align_voice

    rate = 8000
    source = _phrases(rate)
    paths = [tmp_path / name for name in ["voice.wav", "reference.wav", "out.wav"]]
    sf.write(paths[0], source, rate, subtype="FLOAT")
    sf.write(paths[1], np.roll(source, rate * 2), rate, subtype="FLOAT")
    report = align_voice(paths[0], paths[1], paths[2], threading.Event())
    assert report["shiftMs"] == 0
    np.testing.assert_array_equal(sf.read(paths[0])[0], sf.read(paths[2])[0])


def test_timing_never_discards_quiet_boundary_syllable(tmp_path):
    from backend.recordings.studio_adaptive_timing import align_voice

    rate = 8000
    reference = _phrases(rate) * 0.005
    delay = 640
    voice = np.r_[np.zeros(delay), reference[:-delay]]
    voice[:500] = 0.0002 * np.sin(2 * np.pi * 280 * np.arange(500) / rate)
    source, ref, target = [tmp_path / name for name in ("quiet.wav", "ref.wav", "out.wav")]
    sf.write(source, voice, rate, subtype="FLOAT")
    sf.write(ref, reference, rate, subtype="FLOAT")
    report = align_voice(source, ref, target, threading.Event())
    assert report["shiftMs"] == 0
    assert report["reason"] == "boundary-audio-preserved"
    np.testing.assert_array_equal(sf.read(target)[0], sf.read(source)[0])


def test_periodic_syllables_do_not_choose_wrong_equally_matching_delay():
    from backend.recordings.studio_adaptive_timing import _delay_evidence

    reference = np.zeros(2500)
    reference[::12] = 1
    actual = np.roll(reference, 8)
    lag, report = _delay_evidence(actual, reference)
    assert lag == 0
    assert report["reason"] == "ambiguous-onset-periodicity"


@pytest.mark.parametrize("microphone_gain", [1.0, 0.1])
def test_short_vocal_remains_audible_in_new_product_path(tmp_path, microphone_gain):
    rate = 8000
    t = np.arange(rate * 4) / rate
    voice = 0.08 * np.sin(2 * np.pi * 700 * t) * ((t > 1) & (t < 1.7))
    music = 0.05 * np.sin(2 * np.pi * 160 * t)
    paths = [tmp_path / f"{name}.wav" for name in ["voice", "music", "ref", "original", "mix"]]
    captured = voice * microphone_gain
    for path, samples in zip(paths, [captured, music, voice, music, captured + music]):
        sf.write(path, samples, rate, subtype="FLOAT")
    target = tmp_path / "master.wav"
    report = FfmpegStudioMasterRenderer(ProcessRunner()).render(
        *paths[:4],
        target,
        threading.Event(),
        performance_mix=paths[4],
        exact_stems=True,
        process_voice=True,
        adjustments=[{"elapsedSeconds": 0, "sourceSeconds": 0, "playbackRate": 1, "keyShift": 0}],
    )
    actual, _ = sf.read(target)
    selected = (t > 1.1) & (t < 1.6)
    amplitude = abs(np.mean(actual[selected] * np.exp(-2j * np.pi * 700 * t[selected]))) * 2
    assert amplitude > 0.02, "Short singing must not be replaced with instrumental only"
    assert report.processing["pipeline"] == "adaptive-studio-v1"
    gain_plan = report.processing["gainPlan"]
    assert report.payload()["maxBoostDb"] == gain_plan["maxBoostDb"]
    music_amplitude = abs(np.mean(actual[selected] * np.exp(-2j * np.pi * 160 * t[selected]))) * 2
    assert abs(20 * np.log10(amplitude / music_amplitude) - 20 * np.log10(0.08 / 0.05)) < 3


def test_optional_original_in_aac_container_is_decoded(tmp_path):
    from backend.recordings.studio_sources import prepare_sources, IDENTITY_TIMELINE

    renderer = FfmpegStudioMasterRenderer(ProcessRunner())
    source = tmp_path / "source.wav"
    t = np.arange(8000) / 8000
    sf.write(source, 0.1 * np.sin(2 * np.pi * 220 * t), 8000, subtype="FLOAT")
    original = tmp_path / "original.m4a"
    renderer._mix(
        source, source, "[0:a]anull[out]", ["-c:a", "aac", str(original)], threading.Event()
    )
    prepared = prepare_sources(
        renderer,
        source,
        source,
        source,
        source,
        source,
        tmp_path,
        threading.Event(),
        IDENTITY_TIMELINE,
        exact_stems=True,
        original_mix=original,
    )
    assert prepared.original_mix is not None
    assert sf.info(prepared.original_mix).frames == 8000
    assert np.sqrt(np.mean(sf.read(prepared.original_mix)[0] ** 2)) > 0.05


def test_mono_stem_is_not_panned_left_by_multichannel_recovery(tmp_path):
    from backend.recordings.studio_sources import prepare_sources, IDENTITY_TIMELINE

    source, voice = tmp_path / "four.wav", tmp_path / "mono.wav"
    t = np.arange(8000) / 8000
    samples = 0.1 * np.sin(2 * np.pi * 220 * t)
    sf.write(source, np.repeat(samples[:, None], 4, axis=1), 8000, subtype="FLOAT")
    sf.write(voice, samples, 8000, subtype="FLOAT")
    with pytest.raises(DependencyError, match="channels"):
        prepare_sources(
            FfmpegStudioMasterRenderer(ProcessRunner()),
            voice,
            source,
            source,
            source,
            source,
            tmp_path,
            threading.Event(),
            IDENTITY_TIMELINE,
            exact_stems=True,
        )


def test_unreadable_optional_original_uses_verified_reference_stems(tmp_path):
    from backend.recordings.studio_sources import prepare_sources, IDENTITY_TIMELINE

    source, original = tmp_path / "source.wav", tmp_path / "damaged.m4a"
    sf.write(source, 0.1 * np.sin(2 * np.pi * 220 * np.arange(8000) / 8000), 8000)
    original.write_bytes(b"unreadable optional source")
    prepared = prepare_sources(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        source,
        source,
        source,
        source,
        source,
        tmp_path,
        threading.Event(),
        IDENTITY_TIMELINE,
        exact_stems=True,
        original_mix=original,
    )
    assert prepared.original_mix is None
    assert prepared.reference_vocal is not None
    assert prepared.report["originalMixStatus"] == "unreadable-reference-stems-used"


def test_short_optional_original_cannot_set_whole_take_loudness_target(tmp_path):
    from backend.recordings.studio_sources import prepare_sources, IDENTITY_TIMELINE

    source, original = tmp_path / "source.wav", tmp_path / "short.wav"
    samples = 0.1 * np.sin(2 * np.pi * 220 * np.arange(64000) / 8000)
    sf.write(source, samples, 8000)
    sf.write(original, samples[:8000], 8000)
    prepared = prepare_sources(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        source,
        source,
        source,
        source,
        source,
        tmp_path,
        threading.Event(),
        IDENTITY_TIMELINE,
        exact_stems=True,
        original_mix=original,
    )
    assert prepared.original_mix is None
    assert prepared.reference_vocal is not None
    assert prepared.report["originalMixStatus"] == "incomplete-reference-stems-used"


def test_original_mix_cannot_be_overwritten_as_render_target(tmp_path):
    source = tmp_path / "source.wav"
    sf.write(source, np.ones(8000) * 0.1, 8000, subtype="FLOAT")
    original = tmp_path / "original.wav"
    sf.write(original, np.ones(8000) * 0.2, 8000, subtype="FLOAT")
    before = original.read_bytes()
    with pytest.raises(DependencyError, match="overwrite"):
        FfmpegStudioMasterRenderer(ProcessRunner()).render(
            source,
            source,
            source,
            source,
            original,
            threading.Event(),
            performance_mix=source,
            exact_stems=True,
            original_mix=original,
        )
    assert original.read_bytes() == before


def test_invalid_audio_does_not_publish_or_replace_existing_master(tmp_path):
    source, voice = tmp_path / "source.wav", tmp_path / "bad.wav"
    sf.write(source, np.ones(8000) * 0.1, 8000, subtype="FLOAT")
    samples = np.ones(8000) * 0.1
    samples[100] = np.nan
    sf.write(voice, samples, 8000, subtype="FLOAT")
    target = tmp_path / "master.wav"
    target.write_bytes(b"existing master")
    with pytest.raises(DependencyError, match="invalid samples"):
        FfmpegStudioMasterRenderer(ProcessRunner()).render(
            voice,
            source,
            source,
            source,
            target,
            threading.Event(),
            performance_mix=source,
            exact_stems=True,
        )
    assert target.read_bytes() == b"existing master"
    assert not list(tmp_path.glob(".master-*"))
