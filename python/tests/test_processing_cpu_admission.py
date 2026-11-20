from __future__ import annotations

import threading
from pathlib import Path
from unittest.mock import Mock

import numpy as np
import pytest

from backend.ai.domain import SeparatedAudio
from backend.infrastructure.ffmpeg_audio import FfmpegAudioNormalizer
from backend.infrastructure.ffmpeg_media import FfmpegMediaInspector
from backend.infrastructure.process_runner import ProcessResult
from backend.processing.algorithms import MusicMetadata
from backend.processing.audio_pipeline import PrepareProcessingAudio
from backend.processing.compute_policy import ComputeDevice, ExecutionContext
from backend.processing.job_manager import JobContext
from backend.processing.normalize_stage import NormalizeStage
from backend.processing.preflight import ProcessingProviders
from backend.processing.stage_runner import StageRunner
from tests.test_processing_normalized_source import _song


@pytest.mark.parametrize("threads", [1, 2, 4])
def test_normalization_uses_the_admitted_job_budget(tmp_path: Path, threads: int) -> None:
    commands: list[list[str]] = []

    def run(command, **_kwargs):
        commands.append(command)
        return ProcessResult(
            0,
            b"",
            b'{"input_i":-18,"input_lra":2,"input_tp":-9,"input_thresh":-29,"target_offset":0}',
        )

    cache = Mock(get=Mock(return_value=None), put=Mock(side_effect=lambda _key, path: path))
    normalize = NormalizeStage(FfmpegAudioNormalizer(Mock(run=run)), cache, cpu_threads=8)
    provider = Mock(
        separate=Mock(return_value=SeparatedAudio(tmp_path / "music.wav", tmp_path / "voice.wav"))
    )
    audio = PrepareProcessingAudio(
        normalize,
        Mock(analyze=Mock(return_value=MusicMetadata(None, None))),
        Mock(),
        StageRunner(Mock(seconds=Mock(return_value=0.0))),
    )
    audio.run(
        _song(tmp_path / "input.wav"),
        ProcessingProviders(provider, provider, provider, provider),
        tmp_path,
        JobContext("job", threading.Event(), lambda *_args: None),
        [],
        ExecutionContext(ComputeDevice.CPU, threads),
    )
    assert len(commands) == 2
    for command in commands:
        assert command[command.index("-threads") + 1] == str(threads), (
            "Normalization escaped the resource lease and used the global thread budget"
        )
        assert command[command.index("-filter_threads") + 1] == str(threads)


def test_library_waveform_does_not_allocate_a_machine_sized_filter_pool(tmp_path: Path) -> None:
    source = tmp_path / "song.wav"
    source.touch()
    runner = Mock(run=Mock(return_value=ProcessResult(0, np.ones(100, dtype="<f4").tobytes(), b"")))
    assert FfmpegMediaInspector(runner).waveform_peaks(source, 16) == [1.0] * 16
    command = runner.run.call_args.args[0]
    assert "-filter_threads" in command, "A library preview must bound its own filter worker pool"
    assert command[command.index("-filter_threads") + 1] == "1"
