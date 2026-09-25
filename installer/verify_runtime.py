"""Exercise the staged offline runtime before compressing an installer."""

from __future__ import annotations

import importlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def main() -> None:
    resources = Path(sys.argv[1]).resolve(strict=True)
    assert Path(sys.executable).is_relative_to(resources / "python-runtime")
    assert sys.flags.isolated, "Run the packaged interpreter with -I"
    os.environ["PATH"] = os.pathsep.join(
        (str(resources / "tools"), str(Path(os.environ["SystemRoot"]) / "System32"))
    )
    assert not list((resources / "python-runtime/Lib/site-packages").glob("__editable__*"))
    os.environ["AD_VOICE_ENV_FILE"] = os.devnull
    sys.path.insert(0, str(resources / "python-app"))
    modules = (
        "numpy",
        "scipy.signal",
        "torch",
        "torchaudio",
        "soundfile",
        "uvicorn",
        "fastapi",
        "sqlalchemy",
        "yt_dlp",
        "demucs.pretrained",
        "whisper",
        "torchcrepe",
        "shazamio",
        "uroman",
        "backend.main",
        "backend.ai_worker.runtime",
    )
    failures = []
    for name in modules:
        try:
            importlib.import_module(name)
        except Exception as error:
            failures.append(f"{name}: {type(error).__name__}: {error}")
    assert not failures, "Bundled imports failed:\n" + "\n".join(failures)
    for name, module in tuple(sys.modules.items()):
        filename = getattr(vars(module).get("__spec__"), "origin", None)
        if (
            filename
            and filename not in {"built-in", "frozen"}
            and module is not sys.modules["__main__"]
        ):
            assert Path(filename).resolve().is_relative_to(resources), f"External module: {name}"

    import numpy as np
    import soundfile as sf
    import torch
    from scipy.signal import resample_poly

    audio = np.sin(np.arange(4800, dtype=np.float32) * 0.1)
    assert resample_poly(audio, 147, 160).shape == (4410,)
    assert torch.isfinite(torch.fft.rfft(torch.from_numpy(audio))).all()
    with tempfile.TemporaryDirectory(prefix="advoice-runtime-") as directory:
        wav = Path(directory) / "test.wav"
        sf.write(wav, audio, 48000)
        loaded, rate = sf.read(wav)
        assert loaded.shape == audio.shape and rate == 48000
    for tool in ("ffmpeg", "ffprobe"):
        subprocess.run(
            [str(resources / "tools" / f"{tool}.exe"), "-version"],
            cwd=resources / "tools",
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=30,
        )
    print("Offline runtime: imports, CPU DSP, WAV and media tools passed")


if __name__ == "__main__":
    main()
