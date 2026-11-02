from pathlib import Path
import json
import os
import subprocess
import sys

import numpy as np
import pytest


@pytest.mark.parametrize("explicit", [False, True])
def test_speech_worker_caches_timing_compilation_in_profile(
    monkeypatch, tmp_path, capsys, explicit
):
    import numba
    from whisper.timing import dtw_cpu
    from backend.ai_worker import __main__ as worker

    samples = np.random.default_rng(42).normal(size=(8, 24))
    expected = dtw_cpu(samples)
    monkeypatch.setenv("AD_VOICE_DATA", str(tmp_path))
    directory = tmp_path / "explicit" if explicit else tmp_path / "cache" / "numba"
    if explicit:
        monkeypatch.setenv("NUMBA_CACHE_DIR", str(directory))
    else:
        monkeypatch.delenv("NUMBA_CACHE_DIR", raising=False)
    monkeypatch.setattr(numba.config, "CACHE_DIR", "")

    def run(_args):
        assert Path(numba.config.CACHE_DIR) == directory
        np.testing.assert_array_equal(dtw_cpu(samples), expected)
        return {"ok": True}

    monkeypatch.setattr(worker, "_run", run)
    assert worker.main(["transcribe", "--input", str(tmp_path / "vocal.wav")]) == 0
    assert '"ok":true' in capsys.readouterr().out.replace(" ", "")


def test_worker_defaults_compilation_cache_to_its_profile(tmp_path):
    environment = {key: value for key, value in os.environ.items() if key != "NUMBA_CACHE_DIR"}
    environment["AD_VOICE_DATA"] = str(tmp_path)
    script = """
import os, runpy, sys, types
module = types.ModuleType('backend.ai_worker.pitch')
module.pitch = lambda path: {'cache': os.getenv('NUMBA_CACHE_DIR')}
sys.modules[module.__name__] = module
sys.argv = ['worker', 'pitch', '--input', 'unused.wav']
runpy.run_module('backend.ai_worker', run_name='__main__')
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        env=environment,
        capture_output=True,
        check=True,
    )
    assert json.loads(result.stdout)["cache"] == str(tmp_path / "cache" / "numba")
