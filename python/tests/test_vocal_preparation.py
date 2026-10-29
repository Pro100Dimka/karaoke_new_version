from __future__ import annotations

import numpy as np
import pytest


def _clean(raw, estimate, other, rate=44100, speech=None):
    from backend.ai_worker.vocal_preparation import suppress_instrumental_bleed

    return suppress_instrumental_bleed(raw, estimate, other, rate, speech)[0]


def test_confirmed_nonperiodic_bleed_is_reduced_without_changing_raw():
    raw = np.random.default_rng(9).normal(0, 0.03, (2, 44100 * 2)).astype(np.float32)
    original = raw.copy()
    cleaned = _clean(raw, raw * 0.01, raw)
    assert np.linalg.norm(cleaned) < np.linalg.norm(raw) * 0.4
    np.testing.assert_array_equal(raw, original)
    assert cleaned.shape == raw.shape
    assert cleaned.dtype == np.float32
    assert np.isfinite(cleaned).all()


@pytest.mark.parametrize("rate", [44100, 48000])
@pytest.mark.parametrize("harmonics", [(1,), (2, 3, 4), (1, 5, 9)])
@pytest.mark.parametrize("level", [0.1, 0.0001])
def test_quiet_sparse_and_missing_fundamental_survive_voice_in_reference(rate, harmonics, level):
    time = np.arange(2 * rate) / rate
    voice = sum(np.sin(2 * np.pi * 180 * h * time) / h for h in harmonics)
    voice = (level * voice * np.minimum(1, (2 - time) * 5)).astype(np.float32)
    raw = np.stack((voice, -voice))
    # The independent separator misses the voice and assigns a coloured copy to other.
    other = raw + np.roll(raw, 10, axis=1) * 0.8
    cleaned = _clean(raw, np.zeros_like(raw), other, rate)
    np.testing.assert_array_equal(
        cleaned[:, rate // 4 : -rate // 4], raw[:, rate // 4 : -rate // 4]
    )


def test_positive_speech_evidence_preserves_unvoiced_consonants_and_whispers():
    raw = np.random.default_rng(7).normal(0, 0.001, (2, 44100)).astype(np.float32)
    np.testing.assert_array_equal(_clean(raw, raw * 0, raw, speech=np.ones(32)), raw)


def test_missing_ctc_or_vad_is_not_instrumental_evidence():
    raw = np.random.default_rng(7).normal(0, 0.001, (2, 44100)).astype(np.float32)
    np.testing.assert_array_equal(_clean(raw, raw * 0, raw * 0), raw)
    np.testing.assert_array_equal(_clean(raw, raw, raw), raw)


@pytest.mark.parametrize("frames", [0, 1, 73, 4095])
def test_short_audio_abstains_without_inventing_samples(frames):
    raw = np.ones((2, frames), dtype=np.float32) * 0.01
    np.testing.assert_array_equal(_clean(raw, raw * 0, raw), raw)


def test_one_sided_phrase_remains_in_its_original_channel():
    voice = (0.01 * np.sin(np.arange(44100 * 2) * 2 * np.pi * 220 / 44100)).astype(np.float32)
    raw = np.stack((voice, voice * 0))
    np.testing.assert_array_equal(_clean(raw, raw * 0, raw)[:, 5000:-5000], raw[:, 5000:-5000])


def test_mismatched_or_nonfinite_context_is_rejected():
    raw = np.zeros((2, 10000), dtype=np.float32)
    with pytest.raises(ValueError):
        _clean(raw, raw[:, :-1], raw)
    with pytest.raises(ValueError):
        _clean(raw, raw + np.nan, raw)


@pytest.mark.parametrize("fundamental", [0.02, 0])
def test_breathy_pitch_glide_with_weak_fundamental_survives_contaminated_reference(fundamental):
    rate = 44100
    time = np.arange(rate * 2) / rate
    phase = 2 * np.pi * (140 * time + 25 * time**2)
    voice = fundamental * np.sin(phase) + np.sin(phase * 3) + 0.6 * np.sin(phase * 5)
    voice += np.random.default_rng(3).normal(0, 0.2, len(time))
    raw = np.stack((voice, -voice)).astype(np.float32) * 0.001
    result = _clean(raw, raw * 0, raw + np.roll(raw, 8, axis=1))
    core = slice(rate // 4, -rate // 4)
    assert np.linalg.norm(result[:, core] - raw[:, core]) < np.linalg.norm(raw[:, core]) * 0.01


def test_noisy_harmonic_tail_keeps_the_weak_fundamental_missed_by_the_estimator():
    rate = 44100
    time = np.arange(rate * 2) / rate
    fundamental = 0.12 * np.sin(2 * np.pi * 245 * time)
    voice = sum(
        amplitude * np.sin(2 * np.pi * 245 * harmonic * time)
        for harmonic, amplitude in [(2, 0.06), (3, 0.08), (4, 1), (5, 0.1), (6, 0.35), (7, 0.12)]
    )
    estimate = np.stack((voice, voice)).astype(np.float32) * 0.001
    voice += np.random.default_rng(8).normal(0, 0.7, len(time))
    raw = np.stack((voice + fundamental, voice + fundamental)).astype(np.float32) * 0.001
    cleaned = _clean(raw, estimate, raw)
    core = slice(rate // 4, -rate // 4)
    basis = fundamental[core]
    before = np.dot(raw[0, core], basis)
    after = np.dot(cleaned[0, core], basis)
    assert after >= before * 0.95


@pytest.mark.parametrize("estimate_leak", [0, 0.5])
def test_corroborated_high_frequency_bleed_is_reduced_during_singing(estimate_leak):
    from scipy.signal import butter, sosfilt

    rate = 44100
    time = np.arange(rate * 3) / rate
    phase = 2 * np.pi * (180 * time + 8 * time**2)
    voice = sum(np.sin(phase * harmonic) / harmonic for harmonic in range(1, 19)) * 0.05
    sung = (time > 0.5) & (time < 2.5)
    voice *= sung
    noise = sosfilt(
        butter(4, 2500, btype="highpass", fs=rate, output="sos"),
        np.random.default_rng(11).normal(0, 0.01, len(time)),
    )
    raw = np.stack((voice + noise, voice - noise)).astype(np.float32)
    # A clear instrumental-only introduction establishes the profile; the second
    # separator then retains some of that same instrument during the sung phrase.
    leak = estimate_leak * noise * sung
    estimate = np.stack((voice + leak, voice - leak)).astype(np.float32)
    other = np.stack((noise, -noise)).astype(np.float32) * 3.5
    speech = ((np.arange(95) * 0.032 > 0.5) & (np.arange(95) * 0.032 < 2.5)).astype(float)
    cleaned = _clean(raw, estimate, other, speech=speech)
    core = slice(rate // 2, -rate // 2)
    before = np.dot(raw[0, core], noise[core])
    after = np.dot(cleaned[0, core], noise[core])
    assert after < before * 0.8
    assert np.dot(cleaned[0, core], voice[core]) >= np.dot(raw[0, core], voice[core]) * 0.99


def test_unvoiced_syllable_between_sung_notes_is_not_overlap_bleed():
    rate = 44100
    time = np.arange(rate * 3) / rate
    voice = 0.03 * np.sin(2 * np.pi * 220 * time)
    unvoiced = (time > 1.2) & (time < 1.6)
    voice[unvoiced] = np.random.default_rng(4).normal(0, 0.003, np.sum(unvoiced))
    raw = np.stack((voice, -voice)).astype(np.float32)
    estimate = raw.copy()
    estimate[:, unvoiced] = 0
    # A consonant omitted by the independent separator appears in its other stem.
    cleaned = _clean(raw, estimate, raw - estimate, speech=np.ones(95))
    np.testing.assert_array_equal(cleaned, raw)


@pytest.mark.parametrize("coloured", [False, True])
def test_low_held_note_and_changing_second_harmonic_survive_reference_leakage(coloured):
    from scipy.signal import butter, sosfilt

    rate = 44100
    time = np.arange(rate * 3) / rate
    voice = np.sin(2 * np.pi * 65 * time)
    voice += (1.1 + np.sin(2 * np.pi * time)) * np.sin(2 * np.pi * 130 * time)
    voice += sum(np.sin(2 * np.pi * 65 * h * time) / h for h in range(3, 25))
    raw = np.stack((voice, -voice)).astype(np.float32) * 0.0006
    other = np.roll(raw, 79, axis=1) * 15
    if coloured:
        other = sosfilt(butter(3, 1200, fs=rate, output="sos"), other, axis=1).astype(np.float32)
    cleaned = _clean(raw, raw * 0.01, other)
    np.testing.assert_array_equal(
        cleaned[:, rate // 4 : -rate // 4], raw[:, rate // 4 : -rate // 4]
    )


def test_breathy_voice_is_not_instrumental_merely_because_estimator_loses_its_noise():
    from scipy.signal import butter, sosfilt

    rate = 44100
    time = np.arange(rate * 3) / rate
    harmonic = 0.05 * np.sin(2 * np.pi * 220 * time)
    breathiness = sosfilt(
        butter(4, 2500, fs=rate, btype="highpass", output="sos"),
        np.random.default_rng(8).normal(0, 0.01, len(time)),
    )
    raw = np.stack((harmonic + breathiness, harmonic - breathiness)).astype(np.float32)
    estimate = np.stack((harmonic, harmonic)).astype(np.float32)
    # There is no independent instrumental-only context supporting this timbre removal.
    np.testing.assert_array_equal(_clean(raw, estimate, raw - estimate, speech=np.ones(95)), raw)


@pytest.mark.parametrize("rate", [44100, 48000])
def test_detected_isolated_breath_is_ducked_locally_without_moving_or_mutating_voice(rate):
    from backend.ai_worker.breath import attenuate_breath_events

    time = np.arange(3 * rate) / rate
    voice = (np.sin(2 * np.pi * 180 * time) * 0.003).astype(np.float32)
    raw = np.stack((voice, -voice))
    event = (time >= 1) & (time < 1.5)
    raw[:, event] = np.random.default_rng(2).normal(0, 0.01, (2, event.sum()))
    original = raw.copy()
    probability = np.zeros((2, 301), dtype=np.float32)
    probability[:, 100:150] = 0.999
    cleaned, report = attenuate_breath_events(raw, probability, probability * 0, rate)
    core = slice(round(1.1 * rate), round(1.4 * rate))
    assert np.linalg.norm(cleaned[:, core]) < np.linalg.norm(raw[:, core]) * 0.6
    np.testing.assert_array_equal(cleaned[:, :rate], raw[:, :rate])
    np.testing.assert_array_equal(cleaned[:, round(1.5 * rate) :], raw[:, round(1.5 * rate) :])
    np.testing.assert_array_equal(raw, original)
    assert cleaned.shape == raw.shape and cleaned.dtype == raw.dtype
    assert report["decision"] == "attenuated"


@pytest.mark.parametrize("level", [0.1, 0.0001])
def test_voice_in_either_channel_vetoes_breath_attenuation_even_at_high_model_score(level):
    from backend.ai_worker.breath import attenuate_breath_events

    raw = np.random.default_rng(2).normal(0, level, (2, 44100)).astype(np.float32)
    probability = np.zeros((2, 101), dtype=np.float32)
    probability[:, 20:60] = 0.999
    protected = np.zeros_like(probability)
    protected[1] = 1
    cleaned, report = attenuate_breath_events(raw, probability, protected, 44100)
    np.testing.assert_array_equal(cleaned, raw)
    assert report["decision"] == "unchanged"


@pytest.mark.parametrize("first,last,score", [(10, 13, 0.999), (10, 160, 0.999), (20, 60, 0.98)])
def test_uncertain_or_nonlocal_breath_prediction_does_not_authorize_cleanup(first, last, score):
    from backend.ai_worker.breath import attenuate_breath_events

    raw = np.random.default_rng(2).normal(0, 0.01, (2, 88200)).astype(np.float32)
    probability = np.zeros((2, 201), dtype=np.float32)
    probability[:, first:last] = score
    cleaned, report = attenuate_breath_events(raw, probability, probability * 0, 44100)
    np.testing.assert_array_equal(cleaned, raw)
    assert report["decision"] == "unchanged"


@pytest.mark.parametrize("frames", [0, 1, 73, 4095])
def test_breath_stage_abstains_on_short_context_without_loading_a_model(frames, monkeypatch):
    from backend.ai_worker import vocal_preparation

    def unexpected_model(*args, **kwargs):
        raise AssertionError("Short audio must not start breath inference")

    monkeypatch.setattr(vocal_preparation, "model_file", unexpected_model)
    raw = np.zeros((2, frames), dtype=np.float32)
    cleaned, report = vocal_preparation._clean_breaths(raw, raw, raw, 44100, "cpu")
    np.testing.assert_array_equal(cleaned, raw)
    assert report["decision"] == "unchanged:insufficient-context"


@pytest.mark.parametrize("frequency,harmonics", [(65, (1, 2)), (220, (2, 3)), (180, (1, 5, 9))])
def test_quiet_one_sided_harmonics_override_a_false_breath_prediction(
    frequency, harmonics, monkeypatch
):
    from pathlib import Path
    from backend.ai_worker import vocal_preparation

    time = np.arange(3 * 44100) / 44100
    voice = sum(np.sin(2 * np.pi * frequency * h * time) / h for h in harmonics) * 0.0001
    raw = np.stack((np.zeros_like(voice), voice)).astype(np.float32)
    probability = np.zeros((2, 301), dtype=np.float32)
    probability[:, 100:150] = 0.999
    monkeypatch.setattr(vocal_preparation, "model_file", lambda *args: Path("unused"))
    monkeypatch.setattr(vocal_preparation, "detect_breath_events", lambda *args: (probability, []))
    monkeypatch.setattr(vocal_preparation, "get_vad_model", lambda: lambda *args: np.zeros(95))
    cleaned, _ = vocal_preparation._clean_breaths(raw, raw, raw * 0, 44100, "cpu")
    np.testing.assert_array_equal(cleaned, raw)


def test_breath_attenuation_preserves_antiphase_and_has_no_boundary_steps():
    from backend.ai_worker.breath import attenuate_breath_events

    raw = np.ones((2, 88200), dtype=np.float32) * 0.001
    raw[1] *= -1
    probability = np.zeros((2, 201), dtype=np.float32)
    probability[:, 50:100] = 0.999
    cleaned, _ = attenuate_breath_events(raw, probability, probability * 0, 44100)
    np.testing.assert_array_equal(cleaned[0], -cleaned[1])
    assert abs(np.diff(cleaned[0])).max() < 0.000002


@pytest.mark.parametrize("defect", ["shape", "nonfinite", "probability", "rate"])
def test_invalid_breath_evidence_is_rejected(defect):
    from backend.ai_worker.breath import attenuate_breath_events

    raw = np.zeros((2, 44100), dtype=np.float32)
    probability = np.zeros((2, 101), dtype=np.float32)
    protected = probability.copy()
    rate = 44100
    if defect == "shape":
        probability = probability[:, :-1]
    elif defect == "nonfinite":
        probability[0, 0] = np.nan
    elif defect == "probability":
        probability[0, 0] = 1.1
    else:
        rate = 0
    with pytest.raises(ValueError):
        attenuate_breath_events(raw, probability, protected, rate)


def test_preparation_report_tracks_breath_only_changes_and_final_audio(tmp_path, monkeypatch):
    import hashlib
    import soundfile as sf
    from backend.ai_worker import vocal_preparation

    rate = 44100
    voice = (np.sin(np.arange(rate * 2) * 2 * np.pi * 220 / rate) * 0.01).astype(np.float32)
    audio = np.stack((voice, voice))
    source, raw_path = tmp_path / "mix.wav", tmp_path / "raw.wav"
    for path in (source, raw_path):
        sf.write(path, audio.T, rate, subtype="PCM_24")
    raw_hash = hashlib.sha256(raw_path.read_bytes()).hexdigest()
    monkeypatch.setattr(vocal_preparation, "model_file", lambda *args: source)
    monkeypatch.setattr(vocal_preparation, "estimate_voice", lambda mix, *args, **kwargs: mix)
    monkeypatch.setattr(vocal_preparation, "get_vad_model", lambda: lambda *args: np.ones(64))

    def breath_only(raw, cleaned, *args):
        result = cleaned.copy()
        result[:, rate : rate + rate // 2] *= 0.5
        return result, {"decision": "attenuated"}

    monkeypatch.setattr(vocal_preparation, "_clean_breaths", breath_only)
    path, report = vocal_preparation.prepare_vocal(source, raw_path, "cpu")
    assert report["decision"] == "attenuated"
    assert report["regions"]
    assert report["algorithmVersion"] == "adaptive-vocal-6"
    assert report["sha256"]["preparedVocal"] == hashlib.sha256(path.read_bytes()).hexdigest()
    assert hashlib.sha256(raw_path.read_bytes()).hexdigest() == raw_hash


def _voice_with_reflections(rate=44100):
    time = np.arange(rate * 6) / rate
    phase = 2 * np.pi * (160 * time + 8 * time**2)
    envelope = sum(np.exp(-(((time - center) / 0.6) ** 8)) for center in [1, 2.6, 4.3])
    dry = (0.03 * envelope * (np.sin(phase) + 0.4 * np.sin(phase * 2))).astype(np.float32)
    wet = dry.copy()
    for delay, scale in [(0.175, 0.5), (0.35, 0.25)]:
        samples = round(delay * rate)
        wet[samples:] += dry[:-samples] * scale
    return np.stack((dry, -dry)), np.stack((wet, -wet))


def test_preparation_removes_corroborated_overlapping_reflections_on_a_separate_artifact(
    tmp_path, monkeypatch
):
    import hashlib
    import soundfile as sf
    from backend.ai_worker import vocal_preparation

    dry, wet = _voice_with_reflections()
    source, raw_path = tmp_path / "mix.wav", tmp_path / "raw.wav"
    for path in (source, raw_path):
        sf.write(path, wet.T, 44100, subtype="PCM_24")
    raw_hash = hashlib.sha256(raw_path.read_bytes()).hexdigest()
    calls = []

    def estimate(audio, *args, **kwargs):
        calls.append(kwargs.get("separate_channels", False))
        return dry if len(calls) > 1 else wet

    monkeypatch.setattr(vocal_preparation, "estimate_voice", estimate)
    monkeypatch.setattr(vocal_preparation, "model_file", lambda *args: source)
    monkeypatch.setattr(vocal_preparation, "get_vad_model", lambda: lambda *args: np.ones(200))
    monkeypatch.setattr(
        vocal_preparation, "suppress_instrumental_bleed", lambda raw, *args: (raw, {})
    )
    monkeypatch.setattr(
        vocal_preparation, "_clean_breaths", lambda raw, cleaned, *args: (cleaned, {})
    )
    path, report = vocal_preparation.prepare_vocal(source, raw_path, "cpu")
    prepared, _ = sf.read(path, dtype="float32", always_2d=True)
    assert np.mean((prepared.T - dry) ** 2) < np.mean((wet - dry) ** 2) * 0.5
    assert calls == [False, True]
    assert report["algorithmVersion"] == "adaptive-vocal-6"
    assert report["reverberation"]["regions"]
    assert path != raw_path
    assert report["sha256"]["preparedVocal"] == hashlib.sha256(path.read_bytes()).hexdigest()
    assert hashlib.sha256(raw_path.read_bytes()).hexdigest() == raw_hash


@pytest.mark.parametrize("rate", [44100, 48000])
def test_overlapping_reflections_are_reduced_without_folding_antiphase_or_mutating_raw(rate):
    from backend.ai_worker.spatial import suppress_reverberation

    dry, wet = _voice_with_reflections(rate)
    original = wet.copy()
    result, report = suppress_reverberation(wet, dry, rate)
    assert np.mean((result - dry) ** 2) < np.mean((wet - dry) ** 2) * 0.5
    np.testing.assert_array_equal(wet, original)
    np.testing.assert_array_equal(result[0], -result[1])
    assert result.shape == wet.shape and result.dtype == wet.dtype
    assert report["regions"]


@pytest.mark.parametrize("mode", ["antiphase", "one-sided", "sparse"])
def test_clean_quiet_harmonics_are_bit_identical_despite_small_model_rounding(mode):
    from backend.ai_worker.spatial import suppress_reverberation

    time = np.arange(44100 * 2) / 44100
    phase = 2 * np.pi * 65 * time
    voice = (
        np.sin(phase * 2) + 0.6 * np.sin(phase * 3)
        if mode == "sparse"
        else np.sin(phase) + (1.1 + np.sin(2 * np.pi * time)) * np.sin(phase * 2)
    ) * 0.0006
    raw = np.stack((voice, voice * 0 if mode == "one-sided" else -voice)).astype(np.float32)
    result, report = suppress_reverberation(raw, raw * 1.002, 44100)
    np.testing.assert_array_equal(result, raw)
    assert report["decision"] == "unchanged"


@pytest.mark.parametrize("level", [0.03, 0.00003])
def test_model_deleting_a_quiet_sung_phrase_cannot_authorize_its_removal(level):
    from backend.ai_worker.spatial import suppress_reverberation

    voice = np.sin(np.arange(44100 * 3) * 2 * np.pi * 220 / 44100) * level
    raw = np.stack((voice, voice)).astype(np.float32)
    candidate = raw.copy()
    candidate[:, 44100 : 44100 * 2] = 0
    result, _ = suppress_reverberation(raw, candidate, 44100)
    np.testing.assert_array_equal(result[:, 44100 : 44100 * 2], raw[:, 44100 : 44100 * 2])


def test_uncertain_noise_or_unvoiced_syllable_is_not_reverb_from_missing_pitch():
    from backend.ai_worker.spatial import suppress_reverberation

    raw = np.random.default_rng(42).normal(0, 0.003, (2, 44100 * 2)).astype(np.float32)
    result, _ = suppress_reverberation(raw, raw * 0, 44100)
    np.testing.assert_array_equal(result, raw)


def test_a_model_octave_change_is_rejected_locally():
    from backend.ai_worker.spatial import suppress_reverberation

    time = np.arange(44100 * 3) / 44100
    raw = np.stack([np.sin(2 * np.pi * 220 * time)] * 2).astype(np.float32) * 0.02
    candidate = np.stack([np.sin(2 * np.pi * 440 * time)] * 2).astype(np.float32) * 0.02
    result, _ = suppress_reverberation(raw, candidate, 44100)
    np.testing.assert_array_equal(result, raw)


def test_matching_pitch_does_not_authorize_removing_a_weak_fundamental():
    from backend.ai_worker.spatial import suppress_reverberation

    time = np.arange(44100 * 3) / 44100
    phase = 2 * np.pi * 245 * time
    fundamental = np.sin(phase) * 0.00012
    upper = (
        sum(
            amplitude * np.sin(phase * harmonic)
            for harmonic, amplitude in [(2, 0.06), (3, 0.08), (4, 1), (5, 0.1), (6, 0.35)]
        )
        * 0.001
    )
    raw = np.stack((upper + fundamental, upper + fundamental)).astype(np.float32)
    candidate = np.stack((upper, upper)).astype(np.float32)
    result, _ = suppress_reverberation(raw, candidate, 44100)
    core = slice(44100 // 2, -44100 // 2)
    assert (
        np.dot(result[0, core], fundamental[core]) >= np.dot(raw[0, core], fundamental[core]) * 0.95
    )


def test_candidate_clipping_rolls_back_only_the_affected_region():
    from backend.ai_worker.spatial import suppress_reverberation

    time = np.arange(44100 * 3) / 44100
    raw = np.stack([np.sin(2 * np.pi * 220 * time)] * 2).astype(np.float32) * 0.8
    result, report = suppress_reverberation(raw, raw * 2, 44100)
    np.testing.assert_array_equal(result, raw)
    assert any(
        item.get("decision") == "unchanged:pcm-overflow" for item in report["refusedRegions"]
    )


@pytest.mark.parametrize("frames", [0, 1, 4095])
def test_short_reverberation_context_preserves_every_input_sample(frames):
    from backend.ai_worker.spatial import suppress_reverberation

    raw = np.full((2, frames), 0.001, dtype=np.float32)
    result, _ = suppress_reverberation(raw, raw * 0, 44100)
    np.testing.assert_array_equal(result, raw)


@pytest.mark.parametrize("defect", ["shape", "nonfinite", "rate"])
def test_invalid_reverberation_context_is_rejected(defect):
    from backend.ai_worker.spatial import suppress_reverberation

    raw = np.zeros((2, 44100), dtype=np.float32)
    candidate = raw[:, :-1] if defect == "shape" else raw + np.nan if defect == "nonfinite" else raw
    with pytest.raises(ValueError):
        suppress_reverberation(raw, candidate, 0 if defect == "rate" else 44100)
