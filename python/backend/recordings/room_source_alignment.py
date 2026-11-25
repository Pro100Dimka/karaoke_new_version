"""Map separate microphones onto a recipient's measured recording clock."""

from fractions import Fraction
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path
import threading

import av
from av.audio.stream import AudioStream
from av.container import OutputContainer
import numpy as np
import soundfile as sf

from backend.recordings.room_sources import read_room_timeline
from backend.recordings.studio_audio import MasterRenderer, _check_cancel, _temporary_wave
from backend.room.voice_protocol import VOICE_PACKET_FRAMES, VOICE_SAMPLE_RATE_HZ


def _clock_runs(path: Path, frames: int, rate: int) -> list[np.ndarray]:
    runs = []
    points: list[tuple[float, float]] = []
    end = position_end = 0.0
    for offset, position, count in read_room_timeline(path, frames, rate):
        if points and (offset != end or abs(position - position_end) > VOICE_PACKET_FRAMES):
            points.append((end, position_end))
            runs.append(np.asarray(points))
            points = []
        if points and position <= points[-1][1]:
            raise ValueError("Room clock must advance within a continuous capture")
        points.append((float(offset), float(position)))
        end = offset + count
        position_end = position + count * VOICE_SAMPLE_RATE_HZ / rate
    points.append((end, position_end))
    runs.append(np.asarray(points))
    return runs


def align_room_source(
    renderer: MasterRenderer,
    source: Path,
    source_timeline: Path,
    recipient_timeline: Path,
    target: Path,
    cancel: threading.Event,
    *,
    frames: int,
    rate: int,
    channels: int,
) -> None:
    """Preserve pauses and clock drift without estimating delay from different voices."""
    info = sf.info(source)
    source_runs = _clock_runs(source_timeline, info.frames, info.samplerate)
    target_runs = _clock_runs(recipient_timeline, frames, rate)
    staging = target.with_suffix(".nut")
    try:
        _stage_timed_source(source, staging, source_runs, target_runs, rate, cancel)
        renderer._mix(
            staging,
            staging,
            f"[0:a]aresample={rate}:async={rate * 0.03:.0f}:min_hard_comp=0.03:first_pts=0,"
            f"apad,atrim=end_sample={frames},pan={channels}c|"
            + "|".join(f"c{channel}=c0" for channel in range(channels))
            + "[out]",
            ["-c:a", "pcm_f32le", str(target)],
            cancel,
        )
    finally:
        staging.unlink(missing_ok=True)


def align_room_captures(
    renderer: MasterRenderer,
    sources: Sequence[Path],
    timeline: Path,
    target: Path,
    cancel: threading.Event,
    *,
    frames: int,
    rate: int,
    channels: int,
) -> None:
    destination_runs = _clock_runs(timeline, frames, rate)
    _empty_recording(target, frames, rate, channels, cancel)
    with sf.SoundFile(target, "r+") as output:
        for index, (_, source, origin_runs) in enumerate(_ordered_captures(sources)):
            aligned = target.with_stem(f"{target.stem}-capture-{index}")
            try:
                align_room_source(
                    renderer,
                    source / "voice.wav",
                    source / "timeline.csv",
                    timeline,
                    aligned,
                    cancel,
                    frames=frames,
                    rate=rate,
                    channels=channels,
                )
                with sf.SoundFile(aligned) as audio:
                    _copy_intervals(audio, output, origin_runs, destination_runs, cancel)
            finally:
                aligned.unlink(missing_ok=True)


def _overlaps(
    sources: list[np.ndarray], destinations: list[np.ndarray]
) -> Iterator[tuple[np.ndarray, np.ndarray, float, float]]:
    for destination in destinations:
        for origin in sources:
            start, end = (
                max(origin[0, 1], destination[0, 1]),
                min(origin[-1, 1], destination[-1, 1]),
            )
            if end > start:
                yield origin, destination, start, end


@dataclass(slots=True)
class _TimedSourceWriter:
    audio: sf.SoundFile
    stream: AudioStream
    container: OutputContainer
    rate: int
    cancel: threading.Event
    written: bool = False

    def write(self, samples: np.ndarray, position: int) -> None:
        frame = av.AudioFrame.from_ndarray(samples.reshape(1, -1), format="flt", layout="mono")
        frame.sample_rate = self.audio.samplerate
        frame.time_base = Fraction(1, self.rate)
        frame.pts = position
        for packet in self.stream.encode(frame):
            self.container.mux(packet)

    def mux(self, origin: np.ndarray, destination: np.ndarray, start: float, end: float) -> None:
        _check_cancel(self.cancel)
        first, last = np.interp([start, end], origin[:, 1], origin[:, 0])
        offset, limit = int(np.ceil(first)), int(np.floor(last))
        self.audio.seek(offset)
        while offset < limit:
            _check_cancel(self.cancel)
            count = min(4096, limit - offset)
            room_position = np.interp(offset, origin[:, 0], origin[:, 1])
            position = round(float(np.interp(room_position, destination[:, 1], destination[:, 0])))
            if not self.written and position > 0:
                self.write(np.zeros(1, dtype="float32"), 0)
            # Native microphone channels are copies of the same centred input.
            self.write(
                self.audio.read(count, dtype="float32", always_2d=True)[:, 0].copy(), position
            )
            self.written = True
            offset += count

    def finish(self) -> None:
        if not self.written:
            self.write(np.zeros(1, dtype="float32"), 0)
        for packet in self.stream.encode(None):
            self.container.mux(packet)


def _stage_timed_source(
    source: Path,
    staging: Path,
    sources: list[np.ndarray],
    destinations: list[np.ndarray],
    rate: int,
    cancel: threading.Event,
) -> None:
    with sf.SoundFile(source) as audio, av.open(str(staging), "w", format="nut") as container:
        stream = container.add_stream("pcm_f32le", rate=audio.samplerate)
        stream.layout = "mono"
        writer = _TimedSourceWriter(audio, stream, container, rate, cancel)
        for overlap in _overlaps(sources, destinations):
            writer.mux(*overlap)
        writer.finish()


def _copy_intervals(
    audio: sf.SoundFile,
    output: sf.SoundFile,
    sources: list[np.ndarray],
    destinations: list[np.ndarray],
    cancel: threading.Event,
) -> None:
    for _, destination, start, end in _overlaps(sources, destinations):
        first, last = np.interp([start, end], destination[:, 1], destination[:, 0])
        offset, limit = int(np.ceil(first)), int(np.floor(last))
        audio.seek(offset)
        output.seek(offset)
        # A reconnected capture supersedes an overlap instead of doubling it.
        for position in range(offset, limit, 65536):
            _check_cancel(cancel)
            output.write(audio.read(min(65536, limit - position), dtype="float32", always_2d=True))


def _ordered_captures(sources: Sequence[Path]) -> list[tuple[float, Path, list[np.ndarray]]]:
    captures = []
    for source in sources:
        info = sf.info(source / "voice.wav")
        runs = _clock_runs(source / "timeline.csv", info.frames, info.samplerate)
        captures.append((runs[0][0, 1], source, runs))
    return sorted(captures, key=lambda item: item[0])


def _empty_recording(
    target: Path, frames: int, rate: int, channels: int, cancel: threading.Event
) -> None:
    with _temporary_wave(target, samplerate=rate, channels=channels) as output:
        for offset in range(0, frames, 65536):
            _check_cancel(cancel)
            output.write(np.zeros((min(65536, frames - offset), channels), dtype="float32"))
