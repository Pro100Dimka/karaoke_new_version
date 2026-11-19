"""Recover reference balance only when the source mixture proves stem scale."""

import threading

import numpy as np
import pytest
from scipy.signal import butter, sosfilt
import soundfile as sf

from backend.domain_errors import DomainError
from backend.infrastructure.ffmpeg_audio import FfmpegAudioNormalizer
from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_master import FfmpegStudioMasterRenderer
from backend.recordings.studio_reference_level import analyze_reference_level


def _signals(rate=44100, seconds=12):
    time = np.arange(rate * seconds) / rate
    voice = 0.12 * np.sin(2 * np.pi * 173 * time)
    voice += 0.04 * np.sin(2 * np.pi * 519 * time)
    voice *= 0.7 + 0.3 * np.sin(2 * np.pi * 0.37 * time)
    voice = np.column_stack((voice, voice * 0.85))
    backing = 0.1 * np.column_stack(
        (np.sin(2 * np.pi * 809 * time), np.sin(2 * np.pi * 1237 * time))
    )
    backing += np.random.default_rng(81).normal(0, 0.004, backing.shape)
    return voice, backing


def _write(root, voice, backing, source=None, rate=44100, gains=(0.12, 0.03)):
    paths = [root / f"{name}.wav" for name in ("source", "voice", "backing")]
    source = voice + backing if source is None else source
    for path, samples in zip(paths, (source, voice * gains[0], backing * gains[1])):
        sf.write(path, samples, rate, subtype="FLOAT")
    return paths


def _analyze(root, paths, cancel=None):
    return analyze_reference_level(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        *paths,
        root,
        threading.Event() if cancel is None else cancel,
    )


@pytest.mark.parametrize("rate", [44100, 48000])
@pytest.mark.parametrize("gains", [(0.12, 0.03), (0.007, 0.4)])
@pytest.mark.parametrize("antiphase", [False, True])
def test_recovers_independent_publication_gains_without_collapsing_stereo(
    tmp_path, rate, gains, antiphase
):
    voice, backing = _signals(rate)
    if antiphase:
        voice[:, 1] = -voice[:, 0]
    paths = _write(tmp_path, voice, backing, source=(voice + backing) * 0.7, rate=rate, gains=gains)
    originals = [path.read_bytes() for path in paths]
    result = _analyze(tmp_path, paths)
    assert result.correction_db == pytest.approx(20 * np.log10(gains[1] / gains[0]), abs=0.01)
    assert result.report["status"] == "verified"
    assert [path.read_bytes() for path in paths] == originals


@pytest.mark.parametrize(
    "defect",
    [
        "shift",
        "different",
        "phase",
        "nonlinear",
        "silent_voice",
        "correlated",
        "changing_ratio",
        "stereo_mismatch",
        "dynamic_normalization",
        "held_out_only",
        "held_out_silence",
        "held_out_silent_channel",
    ],
)
def test_incompatible_or_unidentifiable_source_cannot_set_vocal_placement(tmp_path, defect):
    voice, backing = _signals()
    source = voice + backing
    if defect == "shift":
        source = np.roll(source, 503, axis=0)
    elif defect == "different":
        source = np.random.default_rng(99).normal(0, 0.05, source.shape)
    elif defect == "phase":
        source[:, 1] *= -1
    elif defect == "nonlinear":
        source = np.tanh(source * 8) / 8
    elif defect == "silent_voice":
        voice[:] = 0
        source = backing.copy()
    elif defect == "correlated":
        backing = voice * 0.7 + backing * 0.0001
        source = voice + backing
    elif defect == "changing_ratio":
        source[: len(source) // 2] = voice[: len(source) // 2] * 2 + backing[: len(source) // 2]
    elif defect == "stereo_mismatch":
        source = source[:, 0]
    elif defect == "dynamic_normalization":
        source[len(source) // 2 :] *= 0.6
    elif defect == "held_out_only":
        odd_seconds = (np.arange(len(source)) // 44100) % 2 == 1
        source[odd_seconds] += np.random.default_rng(31).normal(0, 0.02, source[odd_seconds].shape)
    elif defect in {"held_out_silence", "held_out_silent_channel"}:
        if defect == "held_out_silence":
            source[3 * 44100 : 4 * 44100] = 0
        else:
            source[3 * 44100 : 4 * 44100, 1] = 0
    result = _analyze(tmp_path, _write(tmp_path, voice, backing, source))
    assert result.correction_db is None
    assert result.report["status"] != "verified"


@pytest.mark.parametrize("rate", [44100, 48000])
def test_actual_linear_normalization_and_resampling_preserve_recoverable_balance(tmp_path, rate):
    voice, backing = _signals(rate)
    source = tmp_path / "original.wav"
    normalized = tmp_path / "normalized.wav"
    sf.write(source, voice + backing, rate, subtype="FLOAT")
    runner = ProcessRunner()
    FfmpegAudioNormalizer(runner).normalize(source, normalized, threads=1, cancel=threading.Event())
    samples, normalized_rate = sf.read(normalized, always_2d=True)
    # A deterministic complementary decomposition models separation after the
    # actual import normalizer, without another neural model in this test.
    lower = sosfilt(butter(4, 700, fs=normalized_rate, output="sos"), samples, axis=0)
    vocal, music = tmp_path / "published-voice.wav", tmp_path / "published-music.wav"
    sf.write(vocal, lower * 0.11, normalized_rate, subtype="FLOAT")
    sf.write(music, (samples - lower) * 0.04, normalized_rate, subtype="FLOAT")
    result = _analyze(tmp_path, [source, vocal, music])
    assert result.correction_db == pytest.approx(20 * np.log10(0.04 / 0.11), abs=0.1)


def test_missing_and_corrupt_sources_leave_an_explicit_fallback(tmp_path):
    voice, backing = _signals()
    paths = _write(tmp_path, voice, backing)
    for source in (None, tmp_path / "missing.wav"):
        result = _analyze(tmp_path, [source, *paths[1:]])
        assert result.correction_db is None
        assert result.report["status"] == "unavailable"
    paths[0].write_bytes(b"broken audio")
    result = _analyze(tmp_path, paths)
    assert result.correction_db is None


def test_cancellation_is_not_converted_to_untrusted_reference(tmp_path):
    voice, backing = _signals()
    paths = _write(tmp_path, voice, backing)
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(DomainError) as error:
        _analyze(tmp_path, paths, cancel)
    assert error.value.code in {"JobCancelled", "ProcessCancelled"}


def test_an_instrumental_break_does_not_invent_a_vocal_coefficient(tmp_path):
    voice, backing = _signals()
    voice[4 * 44100 : 8 * 44100] = 0
    result = _analyze(tmp_path, _write(tmp_path, voice, backing))
    assert result.correction_db == pytest.approx(20 * np.log10(0.03 / 0.12), abs=0.01)


def test_joint_source_and_stem_silence_is_valid_evidence(tmp_path):
    voice, backing = _signals()
    voice[4 * 44100 : 8 * 44100] = 0
    backing[4 * 44100 : 8 * 44100] = 0
    result = _analyze(tmp_path, _write(tmp_path, voice, backing))
    assert result.correction_db == pytest.approx(20 * np.log10(0.03 / 0.12), abs=0.01)


def test_small_separation_residual_in_a_quiet_fade_does_not_invalidate_active_source_fit(tmp_path):
    voice, backing = _signals()
    quiet = slice(11 * 44100, 12 * 44100)
    voice[quiet] *= 0.001
    backing[quiet] *= 0.001
    source = voice + backing
    # The model residual is tiny relative to the active song, though its ratio
    # to the near-silent fade is large. It must not be mistaken for a source shift.
    voice[quiet] += np.random.default_rng(16).normal(0, 0.00002, voice[quiet].shape)
    result = _analyze(tmp_path, _write(tmp_path, voice, backing, source))
    assert result.correction_db == pytest.approx(20 * np.log10(0.03 / 0.12), abs=0.01)


def test_a_missing_quiet_source_section_remains_detectable(tmp_path):
    voice, backing = _signals()
    quiet = slice(11 * 44100, 12 * 44100)
    voice[quiet] *= 0.03
    backing[quiet] *= 0.03
    source = voice + backing
    source[quiet] = 0
    assert _analyze(tmp_path, _write(tmp_path, voice, backing, source)).correction_db is None


@pytest.mark.parametrize("cancel_at_last_read", [False, True])
def test_source_evidence_reads_are_bounded_and_final_read_cancellation_propagates(
    tmp_path, monkeypatch, cancel_at_last_read
):
    voice, backing = _signals()
    paths = _write(tmp_path, voice, backing)
    cancel, reads = threading.Event(), []
    original = sf.SoundFile

    class Reader(original):
        def read(self, frames=-1, *args, **kwargs):
            assert 0 < frames <= 2 * self.samplerate
            result = super().read(frames, *args, **kwargs)
            reads.append(frames)
            if cancel_at_last_read and len(reads) == 18:
                cancel.set()
            return result

    monkeypatch.setattr(sf, "SoundFile", Reader)
    if cancel_at_last_read:
        with pytest.raises(DomainError) as error:
            _analyze(tmp_path, paths, cancel)
        assert error.value.code == "ProcessCancelled"
    else:
        assert _analyze(tmp_path, paths, cancel).correction_db is not None
    assert len(reads) == 18
