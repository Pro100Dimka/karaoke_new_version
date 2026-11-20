"""Preconvert scratch doubles only when native FLOAT encoding stays bit-exact."""

import numpy as np
import pytest
import soundfile as sf

from backend.recordings.studio_audio import _temporary_wave


def _rounding_values():
    bits = np.array(
        [0, 1, 2, 0x007FFFFF, 0x00800000, 0x3F800000, 0x3F800001, 0x7F7FFFFE], dtype=np.uint32
    )
    lower = bits.view(np.float32).astype(np.float64)
    upper = (bits + 1).view(np.float32).astype(np.float64)
    halfway = (lower + upper) * 0.5
    specials = np.array([0.0, -0.0, 1e-320, -1e-320, 1e300, -1e300, np.inf, -np.inf, np.nan])
    nan_bits = np.array(
        [0x7FF0000000000001, 0xFFF0000000000001, 0x7FF8765432100000], dtype=np.uint64
    )
    values = np.concatenate(
        [
            lower,
            upper,
            halfway,
            -halfway,
            np.nextafter(halfway, np.inf),
            np.nextafter(halfway, -np.inf),
            specials,
            nan_bits.view(np.float64),
        ]
    )
    return np.resize(values, 8012).reshape(-1, 2)


@pytest.mark.parametrize("layout", ["c", "fortran", "strided"])
def test_double_scratch_writes_use_float_native_io_and_match_native_rounding(
    tmp_path, monkeypatch, layout
):
    values = _rounding_values()
    data = (
        np.asfortranarray(values)
        if layout == "fortran"
        else values[::3]
        if layout == "strided"
        else values
    )
    source_bytes = data.tobytes()
    baseline, target = tmp_path / "native-double.wav", tmp_path / "scratch.wav"
    sf.write(baseline, data, 44100, subtype="FLOAT")
    write = sf.SoundFile.write
    dispatched = []

    def observe(output, samples):
        dispatched.append(np.asarray(samples).dtype)
        write(output, samples)

    monkeypatch.setattr(sf.SoundFile, "write", observe)
    with np.errstate(all="raise"):
        with _temporary_wave(target, samplerate=44100, channels=2) as output:
            output.write(data)
        assert set(np.geterr().values()) == {"raise"}
    expected, rate = sf.read(baseline, dtype="float32", always_2d=True)
    actual, actual_rate = sf.read(target, dtype="float32", always_2d=True)
    assert actual_rate == rate and actual.tobytes() == expected.tobytes()
    assert data.tobytes() == source_bytes
    assert dispatched == [np.dtype("float32")], "Native double-to-FLOAT conversion remains serial"


@pytest.mark.parametrize("dtype", [np.float32, np.int16, np.int32])
def test_other_scratch_dtypes_keep_original_object_and_native_scaling(tmp_path, monkeypatch, dtype):
    data = np.array([[-32768, 0], [1, 32767], [-12, 2]], dtype=dtype)
    baseline, target = tmp_path / "native.wav", tmp_path / "scratch.wav"
    sf.write(baseline, data, 16000, subtype="FLOAT")
    write, dispatched = sf.SoundFile.write, []

    def observe(output, samples):
        dispatched.append(samples)
        write(output, samples)

    monkeypatch.setattr(sf.SoundFile, "write", observe)
    with _temporary_wave(target, samplerate=16000, channels=2) as output:
        output.write(data)
    assert len(dispatched) == 1 and dispatched[0] is data
    assert (
        sf.read(target, dtype="float32")[0].tobytes()
        == sf.read(baseline, dtype="float32")[0].tobytes()
    )


def test_array_like_scratch_writes_keep_existing_coercion(tmp_path, monkeypatch):
    data = [[0.5, -0.5], [2.0, -2.0]]
    write, dispatched = sf.SoundFile.write, []

    def observe(output, samples):
        dispatched.append(samples)
        write(output, samples)

    monkeypatch.setattr(sf.SoundFile, "write", observe)
    target = tmp_path / "scratch.wav"
    with _temporary_wave(target, samplerate=8000, channels=2) as output:
        output.write(data)
    assert len(dispatched) == 1 and dispatched[0] is data
    np.testing.assert_array_equal(sf.read(target)[0], data)


def test_partial_double_scratch_closes_after_stage_exception(tmp_path):
    data = _rounding_values()[:77]
    baseline, target = tmp_path / "native.wav", tmp_path / "scratch.wav"
    sf.write(baseline, data, 8000, subtype="FLOAT")
    with pytest.raises(ValueError, match="cancelled stage"):
        with _temporary_wave(target, samplerate=8000, channels=2) as output:
            output.write(data)
            raise ValueError("cancelled stage")
    assert output.closed and sf.info(target).frames == 77
    assert (
        sf.read(target, dtype="float32")[0].tobytes()
        == sf.read(baseline, dtype="float32")[0].tobytes()
    )
    target.unlink()
