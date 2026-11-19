"""Reference tone correction follows measured broad coloration before placement."""

import threading

import numpy as np
import pytest
import soundfile as sf

from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_audio import _profile
from backend.recordings.studio_master import FfmpegStudioMasterRenderer
from backend.recordings.studio_render import MasterRender


def _singer(rate, seconds=8, frequency=140):
    time = np.arange(round(rate * seconds)) / rate
    phase = 2 * np.pi * np.cumsum(frequency + 1.8 * np.sin(2 * np.pi * 5 * time)) / rate
    voice = np.zeros_like(time)
    for partial in range(1, min(58, int(rate * 0.45 / frequency))):
        hz = partial * frequency
        weight = (0.3 + 2 * np.exp(-0.5 * ((hz - 700) / 350) ** 2)) / partial
        weight += 1.5 * np.exp(-0.5 * ((hz - 1900) / 650) ** 2) / partial
        voice += weight * np.sin(partial * phase + 0.173 * partial)
    voice *= 0.03 / np.sqrt(np.mean(voice**2))
    return time, voice


def _fixture(root, rate=24000, frequency=500, gain=9):
    time, reference = _singer(rate)
    backing = sum(
        amplitude * np.sin(2 * np.pi * hz * time)
        for hz, amplitude in [(970, 0.027), (330, 0.02), (3200, 0.01)]
    )
    paths = {name: root / f"{name}.wav" for name in ("voice", "reference", "backing", "mix")}
    sf.write(paths["reference"], reference, rate, subtype="FLOAT")
    sf.write(paths["backing"], backing, rate, subtype="FLOAT")
    renderer = FfmpegStudioMasterRenderer(ProcessRunner())
    renderer._mix(
        paths["reference"],
        paths["backing"],
        f"[0:a]equalizer=f={frequency}:t=q:w=0.7:g={gain}[out]",
        ["-c:a", "pcm_f32le", str(paths["voice"])],
        threading.Event(),
    )
    sf.write(paths["mix"], sf.read(paths["voice"])[0] + backing, rate, subtype="FLOAT")
    return paths, renderer


def _body_ratio(path):
    cancel = threading.Event()
    body = _profile(path, cancel, voice_band=True, band_hz=(300, 600))
    presence = _profile(path, cancel, voice_band=True, band_hz=(1200, 2400))
    return float(np.median((body - presence)[10:-10]))


def test_active_master_corrects_supported_broad_color_before_calibrating(tmp_path, monkeypatch):
    paths, renderer = _fixture(tmp_path)
    before = {name: path.read_bytes() for name, path in paths.items()}
    actual_vocal = tmp_path / "actual-vocal.wav"
    deliver = MasterRender._deliver

    def capture(render):
        samples, rate = sf.read(render.balanced)
        sf.write(actual_vocal, samples, rate, subtype="FLOAT")
        deliver(render)

    monkeypatch.setattr(MasterRender, "_deliver", capture)
    result = renderer.render(
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
    original_error = _body_ratio(paths["voice"]) - _body_ratio(paths["reference"])
    final_error = _body_ratio(actual_vocal) - _body_ratio(paths["reference"])
    assert original_error > 6
    assert final_error < original_error - 2
    assert result.processing["mixConstraints"]["p90ErrorDb"] < 1
    assert {name: path.read_bytes() for name, path in paths.items()} == before


def _correct(paths, renderer, target, cancel=None, timing=None):
    from backend.recordings.studio_reference_tone import apply_reference_tone

    if timing is None:
        duration = sf.info(paths["voice"]).duration
        axis = np.arange(0.05, duration, 0.1)
        timing = axis, axis
    return apply_reference_tone(
        renderer,
        paths["voice"],
        paths["reference"],
        target,
        cancel or threading.Event(),
        reference_timing=timing,
    )


@pytest.mark.parametrize("rate", [24000, 44100, 48000])
@pytest.mark.parametrize("frequency", [200, 500, 900])
def test_broad_bell_correction_uses_measured_frequency_without_boosting(tmp_path, rate, frequency):
    paths, renderer = _fixture(tmp_path, rate, frequency)
    originals = {name: path.read_bytes() for name, path in paths.items()}

    output, report = _correct(paths, renderer, tmp_path / "tone.wav")

    assert report["applied"]
    assert len(report["bands"]) == 1
    band = report["bands"][0]
    assert abs(np.log2(band["frequencyHz"] / frequency)) < 0.7
    assert -4.5 <= band["gainDb"] <= -1
    before, after = [sf.read(path)[0][rate:-rate] for path in (paths["voice"], output)]
    assert np.mean(after**2) < np.mean(before**2)
    assert (sf.info(output).frames, sf.info(output).samplerate, sf.info(output).channels) == (
        sf.info(paths["voice"]).frames,
        rate,
        1,
    )
    assert {name: path.read_bytes() for name, path in paths.items()} == originals


@pytest.mark.parametrize("kind", ["matched", "quiet", "noise", "other_note", "octave"])
def test_unrelated_or_unneeded_reference_tone_is_unchanged(tmp_path, kind):
    paths, renderer = _fixture(tmp_path, gain=0 if kind == "matched" else 9)
    rate = sf.info(paths["voice"]).samplerate
    if kind == "quiet":
        reference = np.zeros(sf.info(paths["voice"]).frames)
    elif kind == "noise":
        reference = np.random.default_rng(405).normal(0, 0.03, sf.info(paths["voice"]).frames)
    elif kind in {"other_note", "octave"}:
        _, reference = _singer(rate, frequency=210 if kind == "other_note" else 280)
    else:
        reference = sf.read(paths["reference"])[0]
    sf.write(paths["reference"], reference, rate, subtype="FLOAT")
    target = tmp_path / "tone.wav"

    output, report = _correct(paths, renderer, target)

    assert output == paths["voice"]
    assert not report["applied"]
    assert not target.exists()


def test_reference_tone_is_invariant_to_reference_gain_and_keeps_stereo(tmp_path):
    paths, renderer = _fixture(tmp_path)
    rate = sf.info(paths["voice"]).samplerate
    voice, reference = [sf.read(paths[key])[0] for key in ("voice", "reference")]
    sf.write(paths["voice"], np.column_stack((voice, -voice)), rate, subtype="FLOAT")
    reference_path = paths["reference"]
    results = []
    for index, gain in enumerate([0.1, 1, 3]):
        sf.write(reference_path, reference * gain, rate, subtype="FLOAT")
        output, report = _correct(paths, renderer, tmp_path / f"tone-{index}.wav")
        assert report["applied"]
        samples, _ = sf.read(output, always_2d=True)
        np.testing.assert_allclose(samples[:, 0] + samples[:, 1], 0, atol=1e-7)
        results.append(samples)
    for result in results[1:]:
        np.testing.assert_allclose(result, results[0], atol=1e-6)


def test_reference_tone_uses_only_the_mapped_performed_section(tmp_path):
    paths, renderer = _fixture(tmp_path)
    rate = sf.info(paths["reference"]).samplerate
    reference = sf.read(paths["reference"])[0]
    sf.write(paths["reference"], np.r_[np.zeros(rate * 3), reference], rate, subtype="FLOAT")
    axis = np.arange(0.05, sf.info(paths["voice"]).duration, 0.1)

    output, report = _correct(paths, renderer, tmp_path / "tone.wav", timing=(axis, axis + 3))

    assert report["applied"]
    assert _body_ratio(output) < _body_ratio(paths["voice"]) - 2


def test_reference_tone_requires_confirmed_timing(tmp_path):
    from backend.recordings.studio_reference_tone import apply_reference_tone

    paths, renderer = _fixture(tmp_path)
    output, report = apply_reference_tone(
        renderer,
        paths["voice"],
        paths["reference"],
        tmp_path / "tone.wav",
        threading.Event(),
        reference_timing=None,
    )
    assert output == paths["voice"]
    assert not report["applied"]


def test_reference_tone_cancellation_after_bounded_analysis_read(tmp_path, monkeypatch):
    from backend.domain_errors import DomainError

    paths, renderer = _fixture(tmp_path)
    cancel = threading.Event()
    original = sf.SoundFile.read

    def cancel_after_read(audio, frames=-1, *args, **kwargs):
        assert 0 <= frames <= round(audio.samplerate * 0.2)
        samples = original(audio, frames, *args, **kwargs)
        cancel.set()
        return samples

    monkeypatch.setattr(sf.SoundFile, "read", cancel_after_read)
    target = tmp_path / "tone.wav"
    with pytest.raises(DomainError, match="cancel"):
        _correct(paths, renderer, target, cancel=cancel)
    assert not target.exists()


def test_already_calibrated_tone_is_not_cut_again_by_finishing(tmp_path):
    from backend.recordings.studio_voice import integrate_voice

    paths, renderer = _fixture(tmp_path)
    corrected, _ = _correct(paths, renderer, tmp_path / "tone.wav")
    before = corrected.read_bytes()
    axis = np.arange(0.05, sf.info(corrected).duration, 0.1)

    result, report = integrate_voice(
        renderer,
        corrected,
        paths["backing"],
        paths["reference"],
        tmp_path / "finished.wav",
        threading.Event(),
        reference_timing=(axis, axis),
        placement_calibrated=True,
        tone_calibrated=True,
    )

    assert result == corrected
    assert result.read_bytes() == before
    assert max(report["bodyCutDb"]) == 0
    assert max(report["placementTrimDb"]) == 0


@pytest.mark.parametrize("kind", ["octave", "noise", "matched_clean"])
def test_supported_color_cannot_cut_an_unsupported_following_section(tmp_path, kind):
    paths, renderer = _fixture(tmp_path)
    voice, rate = sf.read(paths["voice"])
    time, following = _singer(rate, frequency=280 if kind == "octave" else 140)
    if kind == "noise":
        following = np.random.default_rng(406).normal(0, 0.03, len(time))
    voice[time >= 6.4] = following[time >= 6.4]
    sf.write(paths["voice"], voice, rate, subtype="FLOAT")

    output, report = _correct(paths, renderer, tmp_path / "tone.wav")

    assert report["applied"]
    actual = sf.read(output)[0]
    unsupported = (time >= 6.9) & (time < 7.5)
    np.testing.assert_array_equal(actual[unsupported], sf.read(paths["voice"])[0][unsupported])


def test_a_supported_phrase_is_not_vetoed_by_unmatched_notes_elsewhere(tmp_path):
    paths, renderer = _fixture(tmp_path)
    voice, rate = sf.read(paths["voice"])
    time, following = _singer(rate, frequency=280)
    voice[time >= 2.4] = following[time >= 2.4]
    sf.write(paths["voice"], voice, rate, subtype="FLOAT")

    output, report = _correct(paths, renderer, tmp_path / "tone.wav")

    assert report["applied"]
    actual, original = [sf.read(path)[0] for path in (output, paths["voice"])]
    supported = (time >= 0.8) & (time < 1.8)
    assert 10 * np.log10(np.mean(actual[supported] ** 2) / np.mean(original[supported] ** 2)) < -1.5
    np.testing.assert_array_equal(actual[time >= 3], original[time >= 3])
