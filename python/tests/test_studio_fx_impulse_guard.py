from pathlib import Path
import numpy as np
import soundfile as sf
from backend.recordings.studio_space import SpaceProfile, write_impulse


def test_wet_impulse_has_no_dry_copy(tmp_path: Path) -> None:
    path = tmp_path / 'wet.wav'
    write_impulse(SpaceProfile(delay_seconds=.075, delay_gain=.08, decay_seconds=.4, reverb_gain=.15, stereo_width=.4), path, 44100, 2)
    data, _ = sf.read(path, always_2d=True)
    assert np.all(data[0] == 0)
    assert np.max(np.abs(data[1:])) > 0
    assert data.shape[1] == 2
