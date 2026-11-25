from pathlib import Path
import re
import subprocess
import sys
import pytest


ROOT = Path(__file__).resolve().parents[2]
BUILD_STEPS = "build-steps.mjs"


@pytest.mark.parametrize("wait_pid", [False, True])
def test_automatic_update_waits_for_the_previous_application_to_exit(
    tmp_path: Path, wait_pid: bool
) -> None:
    import os
    import shutil
    import ctypes
    from ctypes import wintypes
    from uuid import uuid4

    compiler = shutil.which("ISCC.exe") or str(
        Path(os.environ.get("ProgramFiles(x86)", "")) / "Inno Setup 6/ISCC.exe"
    )
    if sys.platform != "win32" or not Path(compiler).is_file():
        pytest.skip("Requires Windows and Inno Setup")
    event_name = "Local\\ADVoiceUpdate-" + uuid4().hex
    source = (ROOT / "installer/ad-voice.iss").read_text(encoding="utf-8")
    wait_start = source.find("function OpenProcess(")
    wait_code = (
        source[wait_start : source.index("function RequireClosedApplication(")]
        if wait_start >= 0
        else ""
    )
    # Observe the actual blocking boundary without changing its wait or exit decisions.
    wait_code = wait_code.replace(
        "Status := WaitForSingleObject(", "SignalReady; Status := WaitForSingleObject("
    )
    start = source.index("function PrepareToInstall(")
    prepare = source[start : source.index("function InitializeUninstall:", start)]
    closed = tmp_path / "application-closed"
    payload = tmp_path / "payload.txt"
    payload.write_text("updated", encoding="utf-8")
    script = tmp_path / "update.iss"
    script.write_text(
        "[Setup]\nAppName=Update verification\nAppVersion=1\n"
        f"DefaultDirName={tmp_path / 'installed'}\nOutputDir={tmp_path}\n"
        "OutputBaseFilename=update\nPrivilegesRequired=lowest\n"
        "Uninstallable=no\nCreateUninstallRegKey=no\n"
        f'[Files]\nSource: "{payload}"; DestDir: "{{app}}"\n'
        "[CustomMessages]\nCloseBeforeInstall=Application is still running\n"
        "UpdatePreparing=Waiting for application shutdown\n"
        "[Code]\nvar VerificationPage: TOutputMarqueeProgressWizardPage;\n"
        "procedure InitializeWizard;\nbegin\n"
        "VerificationPage := CreateOutputMarqueeProgressPage('Preparing', 'Checking');\nend;\n"
        "function GetTickCount64: Int64; external 'GetTickCount64@kernel32.dll stdcall';\n"
        "function OpenEvent(Access: LongWord; Inherit: Boolean; Name: String): THandle; external 'OpenEventW@kernel32.dll stdcall';\n"
        "function SetEvent(Handle: THandle): Boolean; external 'SetEvent@kernel32.dll stdcall';\n"
        "function CloseEventHandle(Handle: THandle): Boolean; external 'CloseHandle@kernel32.dll stdcall';\n"
        "procedure SignalReady; var Handle: THandle; begin\n"
        f"Handle := OpenEvent(2, False, '{event_name}');\n"
        "if Handle <> 0 then begin SetEvent(Handle); CloseEventHandle(Handle); end; end;\n"
        f"{wait_code}\n"
        "function RequireClosedApplication(const Message: String): String;\nbegin\nSignalReady;\n"
        f"if FileExists('{closed}') then Result := '' else Result := Message;\nend;\n"
        f"{prepare}",
        encoding="utf-8-sig",
    )
    compiled = subprocess.run([compiler, "/Q", str(script)], capture_output=True)
    assert compiled.returncode == 0, compiled.stdout.decode(
        errors="replace"
    ) + compiled.stderr.decode(errors="replace")
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    api.CreateEventW.argtypes = (ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR)
    api.CreateEventW.restype = wintypes.HANDLE
    api.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
    api.WaitForSingleObject.restype = wintypes.DWORD
    api.CloseHandle.argtypes = (wintypes.HANDLE,)
    ready = api.CreateEventW(None, True, False, event_name)
    assert ready
    owner = subprocess.Popen(
        [
            sys.executable,
            "-c",
            f"import sys; from pathlib import Path; sys.stdin.read(1); Path({str(closed)!r}).touch()",
        ],
        stdin=subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    command = [str(tmp_path / "update.exe"), "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"]
    if wait_pid:
        command.append(f"/WAITPID={owner.pid}")
    installer = subprocess.Popen(command)
    try:
        assert api.WaitForSingleObject(ready, 10_000) == 0
        assert owner.poll() is None
        assert not (tmp_path / "installed/payload.txt").exists()
        owner.communicate(input=b"x", timeout=10)
        assert installer.wait(timeout=30) == 0, "Update must wait before replacing files"
        assert owner.poll() is not None
        assert (tmp_path / "installed/payload.txt").read_text(encoding="utf-8") == "updated"
        assert subprocess.run([*command, f"/WAITPID={owner.pid}"], timeout=30).returncode == 0
    finally:
        if owner.poll() is None:
            owner.communicate(input=b"x", timeout=10)
        installer.wait(timeout=30)
        api.CloseHandle(ready)


def test_explorer_offers_every_audio_format_accepted_by_song_import() -> None:
    from backend.songs.import_song import _ALLOWED_SUFFIXES

    source = (ROOT / "installer/ad-voice.iss").read_text(encoding="utf-8")
    registered_types = set(re.findall(r'\\SupportedTypes";[^\n]*ValueName: "([^"]+)"', source))
    open_with_types = set(
        re.findall(r'\\Classes\\(\.[^\\"]+)\\OpenWithProgids";[^\n]*"ADVoice.Audio"', source)
    )

    assert registered_types == _ALLOWED_SUFFIXES
    assert open_with_types == _ALLOWED_SUFFIXES


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
    start = source.index("function GetTickCount64:")
    check = source[start : source.index("{ An NVIDIA GPU", start)]
    check = check.replace("GetSHA256OfFile(Target)", "CountedFileHash(Target)")
    script = tmp_path / "probe.iss"
    script.write_text(
        "[Setup]\nAppName=Installer verification\nAppVersion=1\n"
        f"DefaultDirName={installed}\nOutputDir={tmp_path}\nOutputBaseFilename=probe\n"
        "PrivilegesRequired=lowest\nUninstallable=no\nCreateUninstallRegKey=no\n"
        "[CustomMessages]\nUpdateChecking=Checked: %1\n"
        f'#include "{catalog}"\n[Code]\nvar PayloadChecks, InstalledPayloadChecks: TStringList;\n'
        "VerificationUpdatedAt: Int64;\n"
        "VerificationPage: TOutputMarqueeProgressWizardPage;\nInstallingPayload: Boolean;\n"
        "procedure InitializeWizard;\nbegin\n"
        "VerificationPage := CreateOutputMarqueeProgressPage('Preparing', 'Checking');\nend;\n"
        "function CountedFileHash(const Name: string): string;\nbegin\n"
        "Log('PAYLOAD_HASH_READ'); Result := GetSHA256OfFile(Name);\nend;\n"
        f"{check}\nprocedure CurStepChanged(Step: TSetupStep);\nbegin\n"
        "if Step = ssPostInstall then SavePayloadChecks;\nend;\n",
        encoding="utf-8-sig",
    )
    subprocess.run(
        [compiler, "/Q", f"/DAppSource={payload}", str(script)], check=True, capture_output=True
    )
    for phase in ("first", "repeat", "repair"):
        log = tmp_path / f"{phase}.log"
        subprocess.run(
            [
                str(tmp_path / "probe.exe"),
                "/VERYSILENT",
                "/NORESTART",
                f"/LOG={log}",
                *(["/VERIFYFILES=1"] if phase == "repair" else []),
            ],
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
            assert "PAYLOAD_HASH_READ" not in log.read_text(encoding="utf-8-sig"), (
                "Normal updates must reuse installed payload metadata without hashing every file"
            )
            timestamp = target.stat().st_mtime_ns
            target.write_bytes(b"tampered")
            os.utime(target, ns=(timestamp, timestamp))
        if phase == "repair":
            assert "PAYLOAD_HASH_READ" in log.read_text(encoding="utf-8-sig")
        assert (installed / "data/recording.wav").read_bytes() == b"keep"

    source_file = payload / "worker.py"
    timestamp = source_file.stat().st_mtime_ns
    source_file.write_bytes(b"updated!")
    os.utime(source_file, ns=(timestamp, timestamp))
    subprocess.run(
        [sys.executable, str(ROOT / "installer/generate_config.py"), str(catalog), str(payload)],
        check=True,
    )
    subprocess.run(
        [compiler, "/Q", f"/DAppSource={payload}", str(script)], check=True, capture_output=True
    )
    log = tmp_path / "new-content.log"
    subprocess.run(
        [str(tmp_path / "probe.exe"), "/VERYSILENT", "/NORESTART", f"/LOG={log}"],
        check=True,
        timeout=30,
    )
    assert target.read_bytes() == b"updated!", "A new payload hash must override identical metadata"
    assert "PAYLOAD_HASH_READ" not in log.read_text(encoding="utf-8-sig")

    for problem in ("missing", "changed", "cache"):
        if problem == "missing":
            target.unlink()
        elif problem == "changed":
            target.write_bytes(b"modified")
        else:
            (installed / "resources/payload-checks.txt").write_text("incomplete cache")
        subprocess.run(
            [str(tmp_path / "probe.exe"), "/VERYSILENT", "/NORESTART"], check=True, timeout=30
        )
        assert target.read_bytes() == b"updated!"
        assert (installed / "data/recording.wav").read_bytes() == b"keep"

    cache = installed / "resources/payload-checks.txt"
    cache.unlink()
    cache.mkdir()
    subprocess.run(
        [str(tmp_path / "probe.exe"), "/VERYSILENT", "/NORESTART"], check=True, timeout=30
    )
    assert target.read_bytes() == b"updated!", (
        "An unwritable optional cache must not fail installation"
    )


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


def test_installer_contains_the_oracle_processing_runtime_without_kaggle() -> None:
    requirements = (ROOT / "python" / "requirements.lock").read_text(encoding="utf-8")
    release = (ROOT / "release.bat").read_text(encoding="utf-8")
    verification = (ROOT / "installer" / "verify_runtime.py").read_text(encoding="utf-8")

    assert "kaggle==" not in requirements
    assert "gradio_client==" not in requirements
    assert "ad_voice_p100.ipynb ad_voice_server.py" not in release
    assert '"backend.infrastructure.oracle_ai_provider"' in verification
    assert '"backend.remote_worker"' in verification


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
    retired = [tmp_path / "kaggle"]
    for package, distribution in (
        ("gradio_client", "gradio_client"),
        ("kaggle", "kaggle"),
        ("kagglesdk", "kagglesdk"),
        ("xdist", "pytest_xdist"),
        ("execnet", "execnet"),
    ):
        retired.extend((site_packages / package, site_packages / f"{distribution}-1.0.dist-info"))
    for directory in retired:
        directory.mkdir()
        (directory / "obsolete.py").write_text("", encoding="utf-8")

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
    assert all(not directory.exists() for directory in retired)
