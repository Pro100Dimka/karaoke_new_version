from __future__ import annotations
from pathlib import Path
from dataclasses import replace
import threading
import math
from typing import TypedDict, NotRequired
import numpy as np
from numpy.typing import NDArray
import soundfile as sf
from scipy.signal import resample_poly, butter, sosfilt
from backend.recordings.studio_space_analysis import SpaceProfile, _decay
from backend.recordings.studio_calibration import GainPlan

from backend.recordings.studio_audio import (
    _PROFILE_SECONDS,
    _VOCAL_TARGET_OFFSET_DB,
    _check_cancel,
    _temporary_wave,
    _profile,
)


def _repeated_output_channels(path: Path, cancel: threading.Event) -> bool:
    with sf.SoundFile(path) as source:
        for samples in source.blocks(blocksize=65536, always_2d=True):
            _check_cancel(cancel)
            if not np.all(samples[:, 2:] == samples[:, 1:2]):
                return False
    return True


def _reference_band_targets(
    reference_vocal: Path, reference_backing: Path, centers: np.ndarray, cancel: threading.Event
) -> np.ndarray | None:
    """Median original vocal-to-backing power per octave, measured on vocal-active blocks."""
    ratios = []
    with sf.SoundFile(reference_vocal) as voice, sf.SoundFile(reference_backing) as music:
        if voice.samplerate != music.samplerate or voice.frames != music.frames:
            return None
        size = 4096
        frequencies = np.fft.rfftfreq(size, 1 / voice.samplerate)
        bands = [(frequencies >= c / np.sqrt(2)) & (frequencies < c * np.sqrt(2)) for c in centers]
        for vb in voice.blocks(blocksize=size, always_2d=True):
            _check_cancel(cancel)
            mb = music.read(len(vb), always_2d=True)
            if len(vb) < size:
                continue
            # Sum spectral energy across channels: averaging stereo waveforms
            # cancels antiphase vocal content and corrupts reference targets.
            window = np.hanning(size)[:, None]
            vp, mp = (
                np.mean(np.abs(np.fft.rfft(x * window, axis=0)) ** 2, axis=1) for x in (vb, mb)
            )
            if np.sum(vp) < 1e-8:
                continue
            ratios.append(
                [
                    10 * np.log10((np.sum(vp[band]) + 1e-12) / (np.sum(mp[band]) + 1e-12))
                    for band in bands
                ]
            )
    if len(ratios) < 3:
        return None
    values = np.asarray(ratios)
    active = np.sum(np.maximum(values, -60), axis=1) >= np.percentile(
        np.sum(np.maximum(values, -60), axis=1), 40
    )
    return np.asarray(np.median(values[active], axis=0))


def _unmask_backing(
    backing: Path,
    voice: Path,
    target: Path,
    active: NDArray[np.bool_],
    cancel: threading.Event,
    reference_vocal: Path | None = None,
    reference_backing: Path | None = None,
) -> dict[str, object]:
    targets = (
        _reference_band_targets(
            reference_vocal,
            reference_backing,
            np.array([250.0, 500.0, 1000.0, 2000.0, 4000.0]),
            cancel,
        )
        if reference_vocal is not None and reference_backing is not None
        else None
    )
    if targets is not None:
        # Keep accompaniment cuts consistent with the chosen vocal balance.
        targets = targets + _VOCAL_TARGET_OFFSET_DB
    with (
        sf.SoundFile(backing) as music,
        sf.SoundFile(voice) as singer,
        _temporary_wave(target, samplerate=music.samplerate, channels=music.channels) as output,
    ):
        return _SpectralUnmasking(music, singer, output, active, cancel, targets).run()


class _SpectralUnmasking:
    def __init__(
        self,
        music: sf.SoundFile,
        singer: sf.SoundFile,
        output: sf.SoundFile,
        active: NDArray[np.bool_],
        cancel: threading.Event,
        reference_targets: np.ndarray | None = None,
    ) -> None:
        self.reference_targets = reference_targets
        self.music, self.singer, self.output = music, singer, output
        self.active, self.cancel = active, cancel
        # Weighted overlap-add retains the sample timeline and bounds memory independently of
        # song length. One smooth spectral gain is shared by all channels to retain stereo cues.
        self.size, self.hop = 2048, 512
        self.window = np.hanning(self.size)
        self.centers = np.asarray([250.0, 500.0, 1000.0, 2000.0, 4000.0])
        self.cut = np.zeros(len(self.centers))
        self.totals = np.zeros(len(self.centers))
        self.maximum = np.zeros(len(self.centers))
        self.windows = self.affected = 0
        self.frequencies = np.fft.rfftfreq(self.size, 1 / self.music.samplerate)
        self.bands = [
            (self.frequencies >= center / np.sqrt(2)) & (self.frequencies < center * np.sqrt(2))
            for center in self.centers
        ]
        self.log_axis = np.log(np.r_[150.0, self.centers, 6500.0])
        self.accumulation = np.zeros((self.size, self.music.channels))
        self.weight = np.zeros(self.size)
        self.frequency_axis = np.log(np.maximum(self.frequencies, 1))
        self.attack = np.exp(-self.hop / (self.music.samplerate * 0.08))
        self.release = np.exp(-self.hop / (self.music.samplerate * 0.25))

    def run(self) -> dict[str, object]:
        # Batch FFTs and disk IO, retaining the sequential envelope and overlap-add.
        for batch_start in range(-self.size + self.hop, self.music.frames, 16 * self.hop):
            _check_cancel(self.cancel)
            starts = np.arange(
                batch_start, min(self.music.frames, batch_start + 16 * self.hop), self.hop
            )
            spectra = self._spectra(batch_start, len(starts))
            desired = self._desired(starts, spectra)
            self._attenuate(starts, spectra[0], desired)
            self._write(starts, spectra[0])
        return {
            "centersHz": self.centers.tolist(),
            "meanReductionDb": (self.totals / max(self.windows, 1)).tolist(),
            "maxReductionDb": self.maximum.tolist(),
            "affectedFraction": self.affected / max(self.windows, 1),
            "limitDb": 1.5,
            "referenceBandTargetsDb": self.reference_targets.tolist()
            if self.reference_targets is not None
            else None,
            "attackMs": 80,
            "releaseMs": 250,
        }

    def _spectra(self, batch_start: int, count: int) -> list[np.ndarray]:
        spectra = []
        for source in (self.music, self.singer):
            samples = np.zeros((self.size + (count - 1) * self.hop, source.channels))
            begin, end = max(0, batch_start), min(source.frames, batch_start + len(samples))
            if end > begin:
                source.seek(begin)
                samples[begin - batch_start : end - batch_start] = source.read(
                    end - begin, always_2d=True
                )
            frames = np.lib.stride_tricks.sliding_window_view(samples, self.size, axis=0)[
                :: self.hop
            ]
            frames = np.moveaxis(frames, -1, 1)
            spectra.append(np.fft.rfft(frames * self.window[None, :, None], axis=1))
        return spectra

    def _desired(self, starts: np.ndarray, spectra: list[np.ndarray]) -> np.ndarray:
        count = len(starts)
        music_power, voice_power = (np.mean(abs(value) ** 2, axis=2) for value in spectra)
        total_voice = np.maximum(np.sum(voice_power, axis=1), 1e-20)
        desired = np.zeros((count, len(self.centers)))
        positions = (starts + self.size / 2) / self.music.samplerate
        indices = (positions / _PROFILE_SECONDS).astype(int)
        eligible = (positions >= 0) & (indices >= 0) & (indices < len(self.active))
        eligible[eligible] &= self.active[indices[eligible]]
        for band, selected in enumerate(self.bands):
            vocal = np.sum(voice_power[:, selected], axis=1)
            instrumental = np.sum(music_power[:, selected], axis=1)
            overlap = 10 * np.log10(np.maximum(instrumental, 1e-20) / np.maximum(vocal, 1e-20))
            if self.reference_targets is None:
                reduction = np.clip(overlap, 0, 1.5)
            else:
                current_prominence = -overlap
                reduction = np.clip(self.reference_targets[band] - current_prominence, 0, 1.5)
            desired[:, band] = np.where(
                eligible & (vocal / total_voice >= 0.01),
                reduction,
                0,
            )
        return desired

    def _attenuate(self, starts: np.ndarray, spectrum: np.ndarray, desired: np.ndarray) -> None:
        count = len(starts)
        for index in range(count):
            coefficient = np.where(desired[index] > self.cut, self.attack, self.release)
            self.cut = coefficient * self.cut + (1 - coefficient) * desired[index]
            attenuation = np.interp(
                self.frequency_axis, self.log_axis, np.r_[0.0, self.cut, 0.0], left=0, right=0
            )
            spectrum[index] *= np.power(10.0, -attenuation[:, None] / 20)
            if starts[index] >= 0:
                self.windows += 1
                self.affected += int(np.max(self.cut) > 0.1)
                self.totals += self.cut
                self.maximum = np.maximum(self.maximum, self.cut)

    def _write(self, starts: np.ndarray, spectrum: np.ndarray) -> None:
        count = len(starts)
        reconstructed = np.fft.irfft(spectrum, n=self.size, axis=1) * self.window[None, :, None]
        pending = np.empty((count * self.hop, self.music.channels))
        pending_frames = 0
        for index, start in enumerate(starts):
            self.accumulation += reconstructed[index]
            self.weight += self.window * self.window
            if start >= 0:
                length = min(self.hop, self.music.frames - start)
                pending[pending_frames : pending_frames + length] = self.accumulation[
                    :length
                ] / np.maximum(self.weight[:length, None], 1e-12)
                pending_frames += length
            self.accumulation[: -self.hop] = self.accumulation[self.hop :]
            self.accumulation[-self.hop :] = 0
            self.weight[: -self.hop] = self.weight[self.hop :]
            self.weight[-self.hop :] = 0
        if pending_frames:
            self.output.write(pending[:pending_frames])


class SpectrumPlan(TypedDict):
    overlap: float
    bands: list[dict[str, float]]
    ratioDb: list[float]
    clarityBands: NotRequired[list[dict[str, float]]]


def _paired_octave_rows(
    voice: Path,
    backing: Path,
    cancel: threading.Event,
    *,
    gain_plan: GainPlan | None = None,
    music_center: bool = False,
) -> list[list[list[float]]]:
    edges = np.array([150, 300, 600, 1200, 2400, 4800, 9600], dtype=float)
    with sf.SoundFile(voice) as singer, sf.SoundFile(backing) as music:
        size = round(singer.samplerate * 0.4)
        hz = np.fft.rfftfreq(size, 1 / singer.samplerate)
        selected = [(hz >= low) & (hz < high) for low, high in zip(edges[:-1], edges[1:])]
        window = np.hanning(size)[:, None]
        rows = []
        for vocal in singer.blocks(blocksize=size, always_2d=True):
            _check_cancel(cancel)
            accompaniment = music.read(len(vocal), always_2d=True)
            if len(vocal) < size:
                continue
            if gain_plan is not None:
                time = (singer.tell() - len(vocal) + np.arange(len(vocal))) / singer.samplerate
                gain = np.interp(time, gain_plan.times, gain_plan.gains)
                vocal *= np.power(10.0, gain[:, None] / 20)
            if music_center:
                accompaniment = accompaniment.mean(axis=1, keepdims=True)
            power = [
                np.mean(abs(np.fft.rfft(x * window, axis=0)) ** 2, axis=1)
                for x in (vocal, accompaniment)
            ]
            rows.append([[float(np.sum(p[band])) for band in selected] for p in power])
    return rows


def measure_mix_spectrum(voice: Path, backing: Path, cancel: threading.Event) -> SpectrumPlan:
    edges = np.array([150, 300, 600, 1200, 2400, 4800, 9600], dtype=float)
    rows = _paired_octave_rows(voice, backing, cancel)
    if not rows:
        return {"overlap": 0.0, "bands": [], "ratioDb": []}
    values = np.asarray(rows)
    activity = np.sum(values[:, 0, 1:5], axis=1)
    active = activity > max(float(np.mean(activity)) * 0.1, 1e-12)
    if not active.any():
        return {"overlap": 0.0, "bands": [], "ratioDb": []}
    energy = np.mean(values[active], axis=0)
    fractions = energy / np.maximum(np.sum(energy, axis=1, keepdims=True), 1e-20)
    overlap = float(np.clip(np.sum(np.sqrt(fractions[0] * fractions[1])), 0, 1))
    ratios = 10 * np.log10(
        np.maximum(values[active, 0], 1e-20) / np.maximum(values[active, 1], 1e-20)
    )
    excess = ratios[:, 1:-1] - (ratios[:, :-2] + ratios[:, 2:]) / 2
    centers = np.sqrt(edges[:-1] * edges[1:])
    nyquist = sf.info(voice).samplerate / 2
    bands = [
        {
            "frequencyHz": float(centers[i + 1]),
            "gainDb": -min(float(np.median(excess[:, i])) * 0.5, 3.0),
        }
        for i in range(4)
        if np.mean(excess[:, i] > 3) >= 0.65
        and edges[i + 3] <= nyquist
        and fractions[0, i + 1] > 0.01
        and fractions[1, i + 1] > 0.01
    ]
    return {"overlap": overlap, "bands": bands, "ratioDb": np.median(ratios, axis=0).tolist()}


def plan_presence_eq(
    voice: Path, backing: Path, plan: GainPlan, cancel: threading.Event
) -> list[dict[str, float]]:
    presence = plan.report.get("presenceCompensationDb")
    if not isinstance(presence, (int, float)) or presence < 1:
        return []
    rows = _paired_octave_rows(voice, backing, cancel, gain_plan=plan, music_center=True)
    if not rows:
        return []
    values = np.asarray(rows)
    vocal = np.sum(values[:, 0, 1:5], axis=1)
    active = vocal > max(float(np.mean(vocal)) * 0.1, 1e-12)
    if not active.any():
        return []
    energy = np.mean(values[active], axis=0)
    shares = energy / np.maximum(np.sum(energy, axis=1, keepdims=True), 1e-20)
    prominence = np.median(
        10
        * np.log10(
            np.maximum(values[active, 0, 2:4], 1e-20) / np.maximum(values[active, 1, 2:4], 1e-20)
        ),
        axis=0,
    )
    weights = np.sqrt(energy[0, 2:4] * energy[1, 2:4])
    weights *= np.all(shares[:, 2:4] > 0.01, axis=0)
    if weights.sum() <= 1e-20:
        return []
    boosts = np.clip(-prominence, 0, 3)
    gain = float(np.average(boosts, weights=weights))
    if gain < 1:
        return []
    frequency = float(
        np.exp(
            np.average(
                np.log([math.sqrt(600 * 1200), math.sqrt(1200 * 2400)]), weights=weights * boosts
            )
        )
    )
    return [{"frequencyHz": frequency, "gainDb": gain}]


def _side_spectra(path: Path, cancel: threading.Event) -> tuple[np.ndarray, int, int]:
    with sf.SoundFile(path) as source:
        rate = source.samplerate
        size = max(4096, 2 ** math.ceil(math.log2(rate * 0.25)))
        powers = np.zeros((2, 3, size // 2 + 1), dtype=complex)
        if source.channels < 2 or source.frames < rate * 6:
            return powers, rate, size
        window = np.hanning(size)[:, None]
        for index, block in enumerate(source.blocks(blocksize=size, always_2d=True)):
            _check_cancel(cancel)
            if len(block) != size:
                continue
            mid_side = np.column_stack((block[:, :2].mean(axis=1), (block[:, 0] - block[:, 1]) / 2))
            mid, side = np.fft.rfft(mid_side * window, axis=0).T
            group = (index * size // (rate * 3)) % 2
            powers[group] += np.stack((abs(mid) ** 2, abs(side) ** 2, mid.conj() * side))
    return powers, rate, size


def _causal_side_kernel(powers: np.ndarray, rate: int, size: int) -> np.ndarray:
    mid, _, cross = powers
    response = cross / np.maximum(mid.real + mid.real.max() * 0.001, 1e-20)
    kernel = np.fft.irfft(response, n=size)[: round(rate * 0.08)].copy()
    kernel[: round(rate * 0.004)] = 0
    fade = max(1, round(rate * 0.001))
    kernel[-fade:] *= np.linspace(1, 0, fade)
    return kernel


def measure_stereo_response(
    path: Path, output_rate: int, cancel: threading.Event
) -> tuple[np.ndarray, float]:
    """Keep only causal stereo responses that predict independent reference windows."""
    powers, rate, size = _side_spectra(path, cancel)
    frequencies = np.fft.rfftfreq(size, 1 / rate)
    band = (frequencies >= 150) & (frequencies <= 3500)
    kernels, scores = [], []
    for group in range(2):
        kernel = _causal_side_kernel(powers[group], rate, size)
        response = np.fft.rfft(kernel, n=size)
        mid, side, cross = powers[1 - group]
        selected = band & (mid.real > mid.real.max() * 0.001)
        if np.count_nonzero(selected) < 64 or side.real[selected].sum() < 1e-12:
            return np.empty(0), 0.0
        error = side.real - 2 * (response.conj() * cross).real + abs(response) ** 2 * mid.real
        score = 1 - float(error[selected].sum() / side.real[selected].sum())
        kernels.append(kernel)
        scores.append(score)
    if min(scores) < 0.1:
        return np.empty(0), min(scores)
    kernel = np.mean(kernels, axis=0)
    if rate != output_rate:
        divisor = math.gcd(rate, output_rate)
        kernel = resample_poly(kernel, output_rate // divisor, rate // divisor) * rate / output_rate
        kernel[: round(output_rate * 0.004)] = 0
    return kernel, min(scores)


def measure_band_tails(path: Path, cancel: threading.Event) -> dict[str, SpaceProfile]:
    bands = [(400.0, 800.0), (800.0, 1600.0), (1600.0, 3200.0), (3200.0, 6400.0)]
    with sf.SoundFile(path) as source:
        bands = [band for band in bands if band[1] < source.samplerate / 2]
        filters = [
            butter(4, band, btype="bandpass", fs=source.samplerate, output="sos") for band in bands
        ]
        states = [np.zeros((len(sos), 2, min(source.channels, 2))) for sos in filters]
        step = max(1, round(source.samplerate * 0.02))
        rows = []
        for block in source.blocks(blocksize=step * 100, always_2d=True):
            _check_cancel(cancel)
            count = len(block) // step
            if not count:
                continue
            powers = []
            for index, sos in enumerate(filters):
                samples, states[index] = sosfilt(sos, block[:, :2], axis=0, zi=states[index])
                frames = samples[: count * step].reshape(count, step, samples.shape[1])
                powers.append(np.mean(frames**2, axis=(1, 2)))
            if powers:
                rows.append(np.stack(powers, axis=1))
    if not rows:
        return {}
    levels = 10 * np.log10(np.maximum(np.concatenate(rows), 1e-12))
    profiles = {}
    for index, band in enumerate(bands):
        decay, gain, count = _decay(levels[:, index])
        if gain:
            profiles[f"tail-{int(band[0])}"] = SpaceProfile(
                decay_seconds=decay,
                reverb_gain=gain,
                decay_count=count,
                tail_band_hz=band,
            )
    return profiles


def plan_band_space(
    reference: Path, voice: Path, width: float, cancel: threading.Event
) -> dict[str, SpaceProfile]:
    expected = measure_band_tails(reference, cancel)
    if not expected:
        return {}
    existing = measure_band_tails(voice, cancel)
    total = float(np.mean(10 ** (_profile(voice, cancel) / 10)))
    selected = {}
    for name, profile in expected.items():
        present = existing.get(name, SpaceProfile())
        if present.decay_seconds > profile.decay_seconds:
            continue
        gain = math.sqrt(max(0.0, profile.reverb_gain**2 - present.reverb_gain**2))
        power = _profile(voice, cancel, voice_band=True, band_hz=profile.tail_band_hz)
        fraction = min(1.0, float(np.mean(10 ** (power / 10))) / max(total, 1e-20))
        if gain > 0:
            selected[name] = replace(
                profile, reverb_gain=gain * math.sqrt(fraction), stereo_width=width
            )
    return selected
