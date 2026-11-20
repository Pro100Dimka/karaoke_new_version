"""Early reference fitting preserves late existing-room protection and spatial PCM."""

from types import SimpleNamespace
import threading

import numpy as np
import pytest
import soundfile as sf
from scipy.ndimage import gaussian_filter1d
from scipy.signal import butter, fftconvolve, sosfilt

from backend.domain_errors import DependencyError
from backend.recordings import studio_regional_space as regional
from backend.recordings.studio_regional_evidence import _valid_intervals
from backend.recordings.studio_regional_levels import RegionalFields


def _fixture(tmp_path, kind):
    rate, seconds = 8000, 18
    rng = np.random.default_rng(7419)
    count = rate * seconds
    envelope = gaussian_filter1d(
        np.repeat(rng.uniform(0.3, 1, seconds * 4), rate // 4), rate * 0.025
    )
    direct = (
        sosfilt(
            butter(2, (500, 3000), fs=rate, btype="bandpass", output="sos"),
            rng.normal(0, 0.06, count),
        )
        * envelope
    )
    returns = []
    for _ in range(2):
        impulse = rng.normal(size=round(rate * 0.65))
        impulse *= np.exp(-6.907755 * np.arange(len(impulse)) / (rate * 0.65))
        impulse[: round(rate * 0.03)] = 0
        impulse /= np.linalg.norm(impulse)
        returns.append(fftconvolve(direct, impulse)[:count])
    dry = np.column_stack((direct, direct))
    wet = np.column_stack(returns) * 0.4
    own = dry + wet * 0.35 if kind == "existing" else dry * (0.35, 1) if kind == "pan" else dry
    voice, reference = tmp_path / "voice.wav", tmp_path / "reference.wav"
    sf.write(voice, own, rate, subtype="FLOAT")
    sf.write(reference, dry + wet, rate, subtype="FLOAT")
    times = (np.arange(seconds * 4) + 0.5) / 4
    valid = ~((times >= 8) & (times < 10)) if kind == "gap" else np.ones(len(times), dtype=bool)
    edges = (0, 15, 18) if kind == "context" else (0, 9, 18) if kind == "repeat" else (0, 18)
    arrangement = SimpleNamespace(
        frames=count,
        rate=rate,
        duration_seconds=seconds,
        times=times,
        reference_valid=valid,
        sections=tuple(
            SimpleNamespace(
                start_seconds=a, end_seconds=b, repeat_group=1 if kind == "repeat" else None
            )
            for a, b in zip(edges[:-1], edges[1:])
        ),
    )
    return voice, reference, arrangement


def _original_plan(voice, reference, arrangement, cancel):
    """Pre-prefit sequence, including whole-region existing ratios before later splitting."""
    from backend.recordings import studio_reference_ambience as estimator

    info = sf.info(voice)
    expected, raw = RegionalFields().measure_pair(voice, reference, cancel)
    existing = regional.exclude_instantaneous_pan(voice, raw, arrangement, cancel)
    if len(expected) < 300 or not len(existing):
        return []
    priors = estimator._global_priors(expected, arrangement)
    reference_end = sf.info(reference).duration
    regions = []
    for section in arrangement.sections:
        end = min(section.end_seconds, reference_end, info.duration)
        for start, end in _valid_intervals(section.start_seconds, end, arrangement):
            region = estimator._candidate_region(start, end, expected, existing, priors)
            if region is not None:
                regions.append(region)
    regions.extend(estimator._repeat_contexts(arrangement, regions, expected, existing))
    regions.extend(
        estimator._context_fallbacks(
            reference, arrangement, regions, expected, existing, priors[1], cancel
        )
    )
    return estimator._reference_bounds(
        sorted(regions, key=lambda region: region.start), arrangement
    )


@pytest.mark.parametrize("kind", ["local", "context", "repeat", "gap", "existing", "pan"])
def test_reference_prefit_keeps_original_regions_existing_ratios_and_rendered_pcm(tmp_path, kind):
    from backend.recordings.studio_reference_ambience import prepare_reference_ambience

    voice, reference, arrangement = _fixture(tmp_path, kind)
    cancel = threading.Event()
    expected = _original_plan(voice, reference, arrangement, cancel)
    prepared = prepare_reference_ambience(reference, arrangement, cancel, channels=2)
    assert prepared is not None
    actual = regional.plan_regional_ambience(
        voice, reference, arrangement, cancel, ambience=prepared
    )
    assert expected
    assert [region.payload() for region in actual] == [region.payload() for region in expected]
    assert all(not region.kernel.flags.writeable for region in prepared.regions)
    first, second = tmp_path / "first.wav", tmp_path / "second.wav"
    args = dict(
        reference=reference,
        arrangement=arrangement,
        base_report={},
        legacy=[],
        existing_wet=0.03,
        legacy_duck=None,
    )
    baseline = regional.render_regional_sends(voice, first, cancel, **args)
    result = regional.render_regional_sends(voice, second, cancel, ambience=prepared, **args)
    assert result == baseline
    before = sf.read(first, dtype="float32", always_2d=True)[0]
    after = sf.read(second, dtype="float32", always_2d=True)[0]
    np.testing.assert_array_equal(after.view(np.uint32), before.view(np.uint32))


def test_prepared_reference_is_measured_once_and_late_voice_keeps_raw_calibration(
    tmp_path, monkeypatch
):
    from backend.recordings import studio_reference_ambience as estimator
    from backend.recordings import studio_regional_levels as levels

    voice, reference, arrangement = _fixture(tmp_path, "pan")
    cancel, measured = threading.Event(), []
    original = levels._field_envelopes

    def measure(path, *args, **kwargs):
        measured.append(path)
        return original(path, *args, **kwargs)

    monkeypatch.setattr(estimator, "_field_envelopes", measure)
    monkeypatch.setattr(levels, "_field_envelopes", measure)
    prepared = estimator.prepare_reference_ambience(reference, arrangement, cancel, channels=2)
    assert measured == [reference]
    fields = levels.RegionalFields()
    regions = regional.plan_regional_ambience(
        voice, reference, arrangement, cancel, fields=fields, ambience=prepared
    )
    assert measured == [reference, voice]
    assert regions and all(region.existing_ratio == 0 for region in regions)
    assert fields.voice is not None and not fields.voice.flags.writeable
    assert np.any(fields.voice[:, :, 1] > 0)
    np.testing.assert_array_equal(fields.voice, original(voice, cancel))


@pytest.mark.parametrize("change", ["source", "missing", "arrangement"])
def test_reference_prefit_cannot_cross_source_identity_or_arrangement(tmp_path, change):
    from backend.recordings.studio_reference_ambience import prepare_reference_ambience

    voice, reference, arrangement = _fixture(tmp_path, "local")
    cancel = threading.Event()
    prepared = prepare_reference_ambience(reference, arrangement, cancel, channels=2)
    if change == "source":
        samples, rate = sf.read(reference, dtype="float32", always_2d=True)
        sf.write(reference, samples * 0.5, rate, subtype="FLOAT")
    elif change == "missing":
        reference.unlink()
    else:
        arrangement = SimpleNamespace(**vars(arrangement))
    with pytest.raises(DependencyError):
        regional.plan_regional_ambience(voice, reference, arrangement, cancel, ambience=prepared)
