import threading
import numpy as np
import pytest
import soundfile as sf
from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_master import FfmpegStudioMasterRenderer
from backend.recordings.studio_render import MasterRender


@pytest.mark.parametrize("dry", [False, True])
def test_final_mix_contains_one_voice_and_one_unchanged_backing(tmp_path, monkeypatch, dry):
    time = np.arange(8000 * 5) / 8000
    voice = 0.03 * np.sin(2 * np.pi * 700 * time)
    music = 0.05 * np.sin(2 * np.pi * 200 * time)
    paths = [tmp_path / n for n in ["voice.wav", "back.wav", "mix.wav"]]
    for path, samples in zip(paths, [voice, music, voice + music]):
        sf.write(path, samples, 8000, subtype="FLOAT")
    original = paths[1].read_bytes()
    stems = []
    deliver = MasterRender._deliver

    def capture(render):
        assert render.backing == paths[1]
        stems.append(sf.read(render.balanced)[0])
        deliver(render)

    monkeypatch.setattr(MasterRender, "_deliver", capture)
    target = tmp_path / "master.wav"
    FfmpegStudioMasterRenderer(ProcessRunner()).render(
        paths[0],
        paths[1],
        paths[0],
        paths[1],
        target,
        threading.Event(),
        performance_mix=paths[2],
        exact_stems=True,
        process_voice=dry,
        adjustments=[{"elapsedSeconds": 0, "sourceSeconds": 0, "playbackRate": 1, "keyShift": 0}],
    )
    actual, _ = sf.read(target)
    np.testing.assert_allclose(actual, stems[0] + music, atol=2e-6)
    assert paths[1].read_bytes() == original
