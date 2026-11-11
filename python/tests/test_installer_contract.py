from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[2]
BUILD_STEPS = "build-steps.mjs"


def test_installer_catalog_tracks_payload_content_and_excludes_user_data(tmp_path: Path) -> None:
    import hashlib

    payload = tmp_path / "app"
    (payload / "resources").mkdir(parents=True)
    (payload / "data").mkdir()
    source = payload / "resources" / "worker.py"
    source.write_bytes(b"first")
    (payload / "data" / "recording.wav").write_bytes(b"private")
    catalog = tmp_path / "catalog.iss"
    command = [
        sys.executable,
        str(ROOT / "installer/generate_config.py"),
        str(catalog),
        str(payload),
    ]
    subprocess.run(command, check=True)
    before = catalog.read_text(encoding="utf-8-sig")
    assert hashlib.sha256(b"first").hexdigest() in before
    assert "FileNeedsUpdate" in before
    assert "recording.wav" not in before
    source.write_bytes(b"other")
    subprocess.run(command, check=True)
    after = catalog.read_text(encoding="utf-8-sig")
    assert hashlib.sha256(b"other").hexdigest() in after
    assert hashlib.sha256(b"first").hexdigest() not in after


def test_installer_prepares_owner_writable_data_and_persists_its_language() -> None:
    source = (ROOT / "installer/ad-voice.iss").read_text(encoding="utf-8")
    assert "icacls.exe" in source
    assert "GetUserNameString" in source
    assert "(OI)(CI)M" in source
    assert "installer-language" in source and "ActiveLanguage" in source
    assert "DeleteFile(ExpandConstant('{app}\\data\\installer-language'))" in source
    assert "Permissions: users-modify" not in source


def test_reinstallation_skips_identical_files_and_repairs_changed_content(tmp_path: Path) -> None:
    import os
    import shutil
    import pytest

    compiler = shutil.which("ISCC.exe") or str(
        Path(os.environ.get("ProgramFiles(x86)", "")) / "Inno Setup 6/ISCC.exe"
    )
    if sys.platform != "win32" or not Path(compiler).is_file():
        pytest.skip("Requires Windows and Inno Setup")
    payload, installed = tmp_path / "payload", tmp_path / "installed"
    payload.mkdir()
    (payload / "worker.py").write_bytes(b"original")
    catalog = tmp_path / "catalog.iss"
    subprocess.run(
        [sys.executable, str(ROOT / "installer/generate_config.py"), str(catalog), str(payload)],
        check=True,
    )
    source = (ROOT / "installer/ad-voice.iss").read_text(encoding="utf-8")
    start = source.index("function FileNeedsUpdate(")
    check = source[start : source.index("{ An NVIDIA GPU", start)]
    script = tmp_path / "probe.iss"
    script.write_text(
        "[Setup]\nAppName=Installer verification\nAppVersion=1\n"
        f"DefaultDirName={installed}\nOutputDir={tmp_path}\nOutputBaseFilename=probe\n"
        "PrivilegesRequired=lowest\nUninstallable=no\nCreateUninstallRegKey=no\n"
        "[CustomMessages]\nUpdateChecking=Checked: %1\n"
        f'#include "{catalog}"\n[Code]\nvar PayloadChecks: TStringList;\n'
        "VerificationPage: TOutputMarqueeProgressWizardPage;\nInstallingPayload: Boolean;\n"
        "procedure InitializeWizard;\nbegin\n"
        "VerificationPage := CreateOutputMarqueeProgressPage('Preparing', 'Checking');\nend;\n"
        f"{check}",
        encoding="utf-8-sig",
    )
    subprocess.run(
        [compiler, "/Q", f"/DAppSource={payload}", str(script)], check=True, capture_output=True
    )
    for phase in ("first", "repeat", "repair"):
        log = tmp_path / f"{phase}.log"
        subprocess.run(
            [str(tmp_path / "probe.exe"), "/VERYSILENT", "/NORESTART", f"/LOG={log}"],
            check=True,
            timeout=30,
        )
        target = installed / "worker.py"
        assert target.read_bytes() == b"original"
        if phase == "first":
            (installed / "data").mkdir()
            (installed / "data/recording.wav").write_bytes(b"keep")
        if phase == "repeat":
            assert "Installing the file." not in log.read_text(encoding="utf-8-sig")
            timestamp = target.stat().st_mtime_ns
            target.write_bytes(b"tampered")
            os.utime(target, ns=(timestamp, timestamp))
        assert (installed / "data/recording.wav").read_bytes() == b"keep"


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


def test_accelerator_startup_cache_is_invalidated_when_the_model_catalog_changes():
    source = (ROOT / "scripts" / "build-steps.mjs").read_text(encoding="utf-8")

    assert 'fingerprint(path.join(root, "python", "backend", "ai", "catalog.py"))' in source
    assert "`.ad-voice-accelerator-${acceleratorVersion}`" in source


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
