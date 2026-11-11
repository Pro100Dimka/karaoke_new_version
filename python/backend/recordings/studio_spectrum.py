from __future__ import annotations
from pathlib import Path
import threading
import numpy as np
from numpy.typing import NDArray
import soundfile as sf

from backend.recordings.studio_audio import _PROFILE_SECONDS, _VOCAL_TARGET_OFFSET_DB, _check_cancel


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
        sf.SoundFile(
            target, "w", samplerate=music.samplerate, channels=music.channels, subtype="FLOAT"
        ) as output,
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
                reduction = np.zeros_like(overlap)
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
