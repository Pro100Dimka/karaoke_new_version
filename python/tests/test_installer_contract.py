from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[2]
BUILD_STEPS = "build-steps.mjs"


def _entrypoint(name: str) -> str:
    """The batch file plus the shared build steps it hands its preparation to."""
    contents = (ROOT / name).read_text(encoding="utf-8")
    if BUILD_STEPS in contents:
        contents += (ROOT / "scripts" / "build-steps.mjs").read_text(encoding="utf-8")
    return contents


def test_installer_installs_and_verifies_youtube_downloader() -> None:
    requirements = (ROOT / "python" / "requirements.lock").read_text(encoding="utf-8")
    installer = _entrypoint("installer.bat")
    startup = _entrypoint("start.bat")

    assert any(line.lower().startswith("yt-dlp==") for line in requirements.splitlines()), (
        "requirements.lock must contain the runtime yt-dlp dependency"
    )
    assert "import yt_dlp" in installer, (
        "installer.bat must verify yt_dlp in the virtual environment before reporting success"
    )
    assert "import yt_dlp" in startup, "start.bat must detect an incomplete existing environment"
    assert "pip install --editable" in startup, (
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
        contents = _entrypoint(entrypoint).lower()
        assert "ensure-ai-runtime.bat" in contents, f"{entrypoint} must repair CPU-only PyTorch"
    steps = (ROOT / "scripts" / "build-steps.mjs").read_text(encoding="utf-8").lower()
    assert steps.index("ensure-ai-runtime.bat") < steps.index("--requirement"), (
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
        contents = _entrypoint(entrypoint).lower()
        assert "backend.ai_worker prepare-accelerator" in contents, (
            f"{entrypoint} must prepare the accelerated model in the shared model store"
        )


def test_installer_contains_the_complete_kaggle_automation_runtime() -> None:
    requirements = (ROOT / "python" / "requirements.lock").read_text(encoding="utf-8")
    release = (ROOT / "release.bat").read_text(encoding="utf-8")
    verification = (ROOT / "installer" / "verify_runtime.py").read_text(encoding="utf-8")

    assert "kaggle==2.2.4" in requirements
    assert "ad_voice_p100.ipynb ad_voice_server.py" in release
    assert '"kaggle.api.kaggle_api_extended"' in verification


def test_installer_repairs_fresh_clone_prerequisites() -> None:
    installer = (ROOT / "installer.bat").read_text(encoding="utf-8").lower()

    assert r"microsoft\windowsapps\winget.exe" in installer
    assert "python313" in installer and "py.exe -3.13" in installer
    assert "python.python.3.13" in installer
    assert "--force" in installer and "uninstall --id" in installer
    first_check = installer.index("call :has_%~1")
    install = installer.index("call :winget_install", first_check)
    assert installer.index("call :has_%~1", install) > install


def test_release_prunes_build_only_python_artifacts_without_removing_runtime_files(
    tmp_path: Path,
) -> None:
    site_packages = tmp_path / "python-runtime" / "Lib" / "site-packages"
    runtime = site_packages / "torch" / "lib"
    headers = site_packages / "torch" / "include"
    dev_package = site_packages / "_pytest"
    for directory in (runtime, headers, dev_package):
        directory.mkdir(parents=True)
    (runtime / "torch.dll").write_bytes(b"runtime")
    (runtime / "torch.lib").write_bytes(b"linker")
    (headers / "torch.h").write_text("header", encoding="utf-8")
    (site_packages / "torch" / "__init__.py").write_text("", encoding="utf-8")
    (site_packages / "torch" / "types.pyi").write_text("", encoding="utf-8")
    bytecode = site_packages / "torch" / "__pycache__"
    bytecode.mkdir()
    (bytecode / "module.cpython-313.pyc").write_bytes(b"cache")
    (dev_package / "__init__.py").write_text("", encoding="utf-8")
    (site_packages / "pytest-1.0.dist-info").mkdir()

    subprocess.run(
        [sys.executable, str(ROOT / "installer" / "prune_runtime.py"), str(tmp_path)],
        check=True,
    )

    assert (runtime / "torch.dll").is_file()
    assert (site_packages / "torch" / "__init__.py").is_file()
    assert not (runtime / "torch.lib").exists()
    assert not headers.exists()
    assert (site_packages / "torch" / "types.pyi").is_file()
    assert not bytecode.exists()
    assert not dev_package.exists()
    assert not (site_packages / "pytest-1.0.dist-info").exists()
