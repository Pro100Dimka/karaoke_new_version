"""Unedited PCM mapping must be exactly the FFmpeg path without starting a DSP process."""

from pathlib import Path
import struct
import subprocess
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_master import FfmpegStudioMasterRenderer
from backend.recordings import studio_pcm


@pytest.mark.parametrize(
    "format,subtype", [("WAV", "FLOAT"), ("WAV", "PCM_24"), ("FLAC", "PCM_24")]
)
@pytest.mark.parametrize("frames,channels", [(17831, 2), (181113, 6)])
def test_stream_copy_matches_ffmpeg_pan_and_float_format(
    tmp_path, format, subtype, frames, channels
):
    source = tmp_path / ("source." + format.lower())
    samples = np.random.default_rng(371).uniform(-0.99, 0.99, (frames, channels))
    sf.write(source, samples, 44100, format=format, subtype=subtype)
    expected, actual = tmp_path / "expected.wav", tmp_path / "actual.wav"
    renderer = FfmpegStudioMasterRenderer(ProcessRunner())
    cancel = threading.Event()
    renderer._mix(
        source,
        source,
        "[0:a]pan=stereo|c0=c0|c1=c1[out]",
        ["-c:a", "pcm_f32le", str(expected)],
        cancel,
    )
    studio_pcm.copy_pcm(source, actual, cancel, frames=frames, channels=2)
    np.testing.assert_array_equal(
        sf.read(actual, dtype="float32")[0], sf.read(expected, dtype="float32")[0]
    )


@pytest.mark.parametrize("frames", [2507, 110000])
def test_identity_timeline_copy_keeps_exact_crop_and_padding(tmp_path, frames):
    source = tmp_path / "source.wav"
    sf.write(source, np.random.default_rng(83).normal(0, 0.1, (68013, 2)), 44100, subtype="FLOAT")
    expected, actual = tmp_path / "expected.wav", tmp_path / "actual.wav"
    renderer = FfmpegStudioMasterRenderer(ProcessRunner())
    cancel = threading.Event()
    renderer._mix(
        source,
        source,
        f"[0:a]apad,atrim=end_sample={frames}[out]",
        ["-c:a", "pcm_f32le", str(expected)],
        cancel,
    )
    studio_pcm.copy_pcm(source, actual, cancel, frames=frames, channels=2)
    np.testing.assert_array_equal(
        sf.read(actual, dtype="float32")[0], sf.read(expected, dtype="float32")[0]
    )


def test_copy_cancelled_before_creation(tmp_path):
    from backend.domain_errors import DomainError

    cancel = threading.Event()
    cancel.set()
    with pytest.raises(DomainError):
        studio_pcm.copy_pcm(Path("missing"), tmp_path / "target.wav", cancel, frames=10, channels=2)
    assert not (tmp_path / "target.wav").exists()


@pytest.mark.parametrize("channels", [1, 2])
def test_unchanged_reference_timeline_needs_no_external_process(tmp_path, channels):
    from types import SimpleNamespace
    from backend.recordings.studio_sources import IDENTITY_TIMELINE, render_timeline

    source, target = tmp_path / "source.wav", tmp_path / "target.wav"
    samples = np.random.default_rng(45).uniform(-0.8, 0.8, (14193, channels)).astype(np.float32)
    sf.write(source, samples, 44100, subtype="FLOAT")

    def external(*args, **kwargs):
        pytest.fail("Unedited PCM should stream without an external DSP process")

    coverage = render_timeline(
        SimpleNamespace(_mix=external),
        source,
        target,
        threading.Event(),
        IDENTITY_TIMELINE,
        frames=len(samples),
        rate=44100,
        channels=channels,
    )
    assert coverage == 1.0
    np.testing.assert_array_equal(sf.read(target, dtype="float32", always_2d=True)[0], samples)


@pytest.mark.parametrize("subtype", ["FLOAT", "PCM_16", "PCM_24", "PCM_32"])
def test_duplicate_capture_check_and_stereo_copy_decode_each_sample_once(
    tmp_path, monkeypatch, subtype
):
    source, target = tmp_path / "source.wav", tmp_path / "stereo.wav"
    stereo = np.random.default_rng(816).uniform(-0.8, 0.8, (90017, 2))
    sf.write(source, np.column_stack((stereo[:, 0], *([stereo[:, 1]] * 5))), 44100, subtype=subtype)
    expected = sf.read(source, dtype="float32")[0][:, :2]
    original, reads = sf.SoundFile.read, []

    def read(self, *args, **kwargs):
        result = original(self, *args, **kwargs)
        if Path(self.name) == source:
            reads.append(len(result))
        return result

    monkeypatch.setattr(sf.SoundFile, "read", read)
    result = studio_pcm.copy_repeated_stereo(source, target, threading.Event())
    assert result == target and sum(reads) == len(stereo)
    np.testing.assert_array_equal(sf.read(target, dtype="float32")[0], expected)


def test_real_surround_channel_at_end_rejects_stereo_fold(tmp_path):
    source, target = tmp_path / "source.wav", tmp_path / "stereo.wav"
    samples = np.zeros((90000, 6))
    samples[-1, -1] = 1 / 2**31
    sf.write(source, samples, 44100, subtype="PCM_32")
    assert studio_pcm.copy_repeated_stereo(source, target, threading.Event()) is None
    assert not target.exists()


def _source_with_layout(tmp_path, format, channels, mask):
    source = tmp_path / ("source." + format.lower())
    samples = np.random.default_rng(901).uniform(-0.5, 0.5, (2049, channels))
    sf.write(source, samples, 44100, format=format, subtype="PCM_24")
    if format in {"WAVEX", "RF64"}:
        data = bytearray(source.read_bytes())
        fmt = data.index(b"fmt ")
        assert struct.unpack_from("<H", data, fmt + 8)[0] == 0xFFFE
        struct.pack_into("<I", data, fmt + 28, mask)
        source.write_bytes(data)
    elif mask is not None:
        tagged = tmp_path / "tagged.flac"
        subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-v",
                "error",
                "-y",
                "-i",
                str(source),
                "-c:a",
                "copy",
                "-metadata",
                f"WAVEFORMATEXTENSIBLE_CHANNEL_MASK={mask:#x}",
                str(tagged),
            ],
            check=True,
            capture_output=True,
        )
        source = tagged
    return source


@pytest.mark.parametrize(
    "format,channels,mask",
    [("WAVEX", 2, 0x0C), ("RF64", 2, 0x0C), ("FLAC", 3, None), ("FLAC", 2, 0x0C)],
)
def test_identity_timeline_preserves_ffmpeg_channel_layout_conversion(
    tmp_path, monkeypatch, format, channels, mask
):
    from backend.recordings import studio_sources

    source = _source_with_layout(tmp_path, format, channels, mask)
    actual, expected = tmp_path / "actual.wav", tmp_path / "expected.wav"
    renderer = FfmpegStudioMasterRenderer(ProcessRunner())
    cancel = threading.Event()
    studio_sources.render_timeline(
        renderer,
        source,
        actual,
        cancel,
        studio_sources.IDENTITY_TIMELINE,
        frames=2049,
        rate=44100,
        channels=channels,
    )
    monkeypatch.setattr(studio_sources, "copy_identity_timeline", lambda *args: False)
    studio_sources.render_timeline(
        renderer,
        source,
        expected,
        cancel,
        studio_sources.IDENTITY_TIMELINE,
        frames=2049,
        rate=44100,
        channels=channels,
    )
    original = sf.read(source, dtype="float32", always_2d=True)[0]
    remapped = sf.read(expected, dtype="float32", always_2d=True)[0]
    assert not np.array_equal(original, remapped), "Fixture must require channel remapping"
    np.testing.assert_array_equal(sf.read(actual, dtype="float32", always_2d=True)[0], remapped)
