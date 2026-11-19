"""The first master must receive the local song source needed to recover stem levels."""

from contextlib import contextmanager, nullcontext
from datetime import UTC, datetime
from types import SimpleNamespace
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.domain import Recording
from backend.recordings.start_studio_master import StartStudioMaster
from backend.recordings.studio_master import FfmpegStudioMasterRenderer


@pytest.mark.parametrize("source_state", ["available", "missing-file", "portable", "missing-song"])
def test_master_passes_available_song_source_without_requiring_it(tmp_path, source_state):
    source = tmp_path / "song.mp3"
    if source_state == "available":
        source.write_bytes(b"untouched original song")
    mix = tmp_path / "take.wav"
    mix.write_bytes(b"untouched performance")
    recording = Recording(
        "take", mix, 12, 44100, 2, datetime.now(UTC), song_id="song", song_revision=2
    )
    song = SimpleNamespace(source_path=None if source_state == "portable" else source)
    observed = {}

    @contextmanager
    def transaction():
        yield SimpleNamespace(
            recordings=SimpleNamespace(get=lambda key: recording),
            songs=SimpleNamespace(get=lambda key: None if source_state == "missing-song" else song),
        )

    def render(*args, **kwargs):
        observed.update(kwargs)
        return SimpleNamespace(payload=lambda: {"checked": True})

    workspace = tmp_path / "work"
    workspace.mkdir()
    service = StartStudioMaster(
        SimpleNamespace(create=transaction),
        None,
        SimpleNamespace(artifact_path=lambda song_id, revision, name: tmp_path / (name + ".wav")),
        None,
        None,
        None,
        SimpleNamespace(allocate=lambda name: workspace, cleanup=lambda path: None),
        SimpleNamespace(render=render),
        SimpleNamespace(execute=lambda *args: SimpleNamespace(recording_id="master")),
    )
    service._stems = lambda take: (tmp_path / "take.dry.wav", tmp_path / "backing.wav")
    service._pitch_session = lambda context: nullcontext(None)
    context = SimpleNamespace(
        cancel=threading.Event(), ensure_not_cancelled=lambda: None, progress=lambda *args: None
    )

    result = service._run(recording, context)

    assert observed["reference_mix"] == (source if source_state == "available" else None)
    assert observed["performance_mix"] == mix
    assert observed["process_voice"] is True
    assert result["recordingId"] == "master"
    assert mix.read_bytes() == b"untouched performance"
    if source_state == "available":
        assert source.read_bytes() == b"untouched original song"


@pytest.mark.parametrize("source_available", [False, True])
def test_partial_take_recovers_different_source_balances_from_identical_published_stems(
    tmp_path, source_available
):
    rate = 16000
    time = np.arange(rate * 12) / rate
    phase = 2 * np.pi * (180 * time + 0.4 * np.sin(2 * np.pi * 4.3 * time))
    envelope = 0.6 + 0.4 * np.sin(np.pi * time / 1.7) ** 2
    voice = 0.025 * envelope * sum(np.sin(h * phase) / h for h in range(1, 12))
    voice = np.repeat(voice[:, None], 2, axis=1)
    backing = np.random.default_rng(7701).normal(0, 0.012, voice.shape)
    paths = {
        name: tmp_path / (name + ".wav")
        for name in ["voice", "take", "reference", "backing", "mix"]
    }
    count = rate * 6
    for name, samples in {
        "voice": voice[:count],
        "take": backing[:count],
        "reference": voice,
        "backing": backing,
        "mix": voice[:count] + backing[:count],
    }.items():
        sf.write(paths[name], samples, rate, subtype="FLOAT")
    results = []
    for ratio_db in [-12, 0]:
        source = tmp_path / f"source-{ratio_db}.wav"
        sf.write(source, voice * 10 ** (ratio_db / 20) + backing, rate, subtype="FLOAT")
        result = FfmpegStudioMasterRenderer(ProcessRunner()).render(
            paths["voice"],
            paths["take"],
            paths["reference"],
            paths["backing"],
            tmp_path / f"master-{ratio_db}.wav",
            threading.Event(),
            performance_mix=paths["mix"],
            reference_mix=source if source_available else None,
            exact_stems=True,
            adjustments=[
                {"elapsedSeconds": 0, "sourceSeconds": 0, "playbackRate": 1, "keyShift": 0}
            ],
        )
        results.append(result.vocal_gain_db)
        assert sf.info(tmp_path / f"master-{ratio_db}.wav").frames == count

    assert results[1] - results[0] == pytest.approx(12 if source_available else 0, abs=0.6)
