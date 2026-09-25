from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_installer_installs_and_verifies_youtube_downloader() -> None:
    requirements = (ROOT / "python" / "requirements.lock").read_text(encoding="utf-8")
    installer = (ROOT / "installer.bat").read_text(encoding="utf-8")
    startup = (ROOT / "start.bat").read_text(encoding="utf-8")

    assert any(
        line.lower().startswith("yt-dlp==") for line in requirements.splitlines()
    ), "requirements.lock must contain the runtime yt-dlp dependency"
    assert "import yt_dlp" in installer, (
        "installer.bat must verify yt_dlp in the virtual environment before reporting success"
    )
    assert "import yt_dlp" in startup, "start.bat must detect an incomplete existing environment"
    assert 'pip install --editable "%ROOT%python"' in startup, (
        "start.bat must repair missing runtime dependencies from pyproject.toml"
    )


def test_windows_entrypoints_repair_cpu_only_torch_on_nvidia_machines() -> None:
    accelerator = ROOT / "ensure-ai-runtime.bat"
    assert accelerator.is_file(), "the CUDA runtime repair must be shared by every entrypoint"
    script = accelerator.read_text(encoding="utf-8").lower()
    assert "nvidia-smi.exe" in script
    assert "torch.cuda.is_available()" in script
    assert "https://download.pytorch.org/whl/cu130" in script
    for entrypoint in ("installer.bat", "start.bat", "start-multy.bat"):
        contents = (ROOT / entrypoint).read_text(encoding="utf-8").lower()
        assert "ensure-ai-runtime.bat" in contents, f"{entrypoint} must repair CPU-only PyTorch"
    installer = (ROOT / "installer.bat").read_text(encoding="utf-8").lower()
    assert installer.index("ensure-ai-runtime.bat") < installer.index("requirements.lock"), (
        "the installer must select CUDA before resolving the lock file, not download CPU PyTorch first"
    )


def test_locked_torch_packages_use_one_compatible_release() -> None:
    versions = {}
    for line in (ROOT / "python" / "requirements.lock").read_text(encoding="utf-8").splitlines():
        name, separator, version = line.partition("==")
        if separator and name.lower() in {"torch", "torchaudio"}:
            versions[name.lower()] = version
    assert versions == {"torch": "2.11.0", "torchaudio": "2.11.0"}
    setuptools = next(
        line.partition("==")[2]
        for line in (ROOT / "python" / "requirements.lock").read_text(encoding="utf-8").splitlines()
        if line.lower().startswith("setuptools==")
    )
    assert setuptools == "78.1.0", "PyTorch 2.11 requires setuptools below version 82"


def test_entrypoints_prepare_the_shared_accelerated_whisper_model() -> None:
    requirements = (ROOT / "python" / "requirements.lock").read_text(encoding="utf-8").lower()
    assert "faster-whisper==" in requirements
    for entrypoint in ("installer.bat", "start.bat", "start-multy.bat"):
        contents = (ROOT / entrypoint).read_text(encoding="utf-8").lower()
        assert "backend.ai_worker prepare-accelerator" in contents, (
            f"{entrypoint} must prepare the accelerated model in the shared model store"
        )
