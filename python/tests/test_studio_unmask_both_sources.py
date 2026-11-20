import threading
import numpy as np
import pytest
import soundfile as sf
from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_master import FfmpegStudioMasterRenderer
from backend.recordings import studio_adaptive_mix as adaptive_mix


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
    deliver = adaptive_mix.deliver_master
    sends = adaptive_mix.render_sends

    def capture_sends(voice, backing, target, cancel, **kwargs):
        if kwargs.get("backing_ready") is not None:
            kwargs["backing_ready"]()
        np.testing.assert_allclose(sf.read(backing)[0], music, atol=1e-7)
        result = sends(voice, backing, target, cancel, **kwargs)
        stems.append(sf.read(target)[0])
        return result

    def capture_mix(renderer, source, target, cancel, **kwargs):
        # The bus must contain one processed voice plus one project backing.
        # Its later limiter/resampler is not a linear gain operation.
        np.testing.assert_allclose(sf.read(source)[0], stems[-1] + music, atol=1e-7)
        return deliver(renderer, source, target, cancel, **kwargs)

    monkeypatch.setattr(adaptive_mix, "render_sends", capture_sends)
    monkeypatch.setattr(adaptive_mix, "deliver_master", capture_mix)
    target = tmp_path / "master.wav"
    result = FfmpegStudioMasterRenderer(ProcessRunner()).render(
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
    assert actual.shape == music.shape
    assert result.processing["delivery"]["truePeakDbtp"] <= -1
    assert paths[1].read_bytes() == original
    assert result.processing["gainPlan"]["gainApplications"] == 1
    reference = tmp_path / "reference.wav"
    sf.write(reference, voice, 8000, subtype="FLOAT")
    levels = [(0.25, 0.1), (4, 4), (1, 0), (1, np.where(time < 2, 0, 4))]
    if dry:
        levels.extend([(0, 0), (np.where(time < 2, 0, 4), 1)])
    for mic_gain, music_gain in levels:
        sf.write(paths[0], voice if dry else voice * mic_gain, 8000, subtype="FLOAT")
        sf.write(paths[1], music * music_gain, 8000, subtype="FLOAT")
        monitored_voice = voice.copy()
        if dry:
            # Karaoke effects belong to the listening mix, never the mastering source.
            for delay, gain in [(0.0297, 0.3), (0.0371, 0.3), (0.0411, 0.3), (0.11, 0.4)]:
                frames = round(delay * 8000)
                monitored_voice[frames:] += voice[:-frames] * gain
        sf.write(paths[2], monitored_voice * mic_gain + music * music_gain, 8000, subtype="FLOAT")
        project = tmp_path / "project.wav"
        sf.write(project, music, 8000, subtype="FLOAT")
        inputs = [*paths, reference, project]
        untouched = [path.read_bytes() for path in inputs]
        report = FfmpegStudioMasterRenderer(ProcessRunner()).render(
            paths[0],
            paths[1],
            reference,
            project,
            target,
            threading.Event(),
            performance_mix=paths[2],
            exact_stems=True,
            process_voice=dry,
            adjustments=[
                {"elapsedSeconds": 0, "sourceSeconds": 0, "playbackRate": 1, "keyShift": 0}
            ],
        )
        changed, _ = sf.read(target)
        np.testing.assert_allclose(changed, actual, atol=1e-4)
        assert report.processing["gainPlan"]["referenceUsed"]
        assert [path.read_bytes() for path in inputs] == untouched
