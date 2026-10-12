import os
import shutil
import subprocess
import tarfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def _bash_path(path: Path) -> str:
    value = path.as_posix()
    return f"/{value[0].lower()}{value[2:]}" if os.name == "nt" else value


def test_room_server_update_is_one_click_and_rolls_back_on_failed_health_check() -> None:
    launcher = (ROOT / "update-room-server.bat").read_text(encoding="utf-8")
    powershell = (ROOT / "scripts" / "update-room-server.ps1").read_text(encoding="utf-8")
    remote = (ROOT / "scripts" / "deploy-room-server.sh").read_text(encoding="utf-8")

    assert "update-room-server.ps1" in launcher
    assert "AD_VOICE_ROOM_SERVER_SSH_KEY" in powershell
    assert "AD_VOICE_ROOM_SERVER_KNOWN_HOSTS" in powershell
    assert "AD_VOICE_ROOM_SERVER_SSH_USER" in powershell
    assert "Read-DotEnvValue" in powershell
    assert "icacls.exe" in powershell
    assert "test_room_server.py" in powershell
    assert "test_voice_relay.py" in powershell
    assert "backend.backup-$stamp" in remote
    assert "/health/ready" in remote
    assert "rollback" in remote


def test_local_secrets_directory_is_excluded_from_git() -> None:
    ignores = (ROOT / ".gitignore").read_text(encoding="utf-8")

    assert "/local-secrets/" in ignores


def test_room_server_deploy_script_is_normalized_for_linux_before_upload() -> None:
    powershell = (ROOT / "scripts" / "update-room-server.ps1").read_text(encoding="utf-8")

    assert "$normalizedDeployScript" in powershell
    assert '.Replace("`r`n", "`n")' in powershell
    assert '$normalizedDeployScript "${destination}:$remoteScript"' in powershell


def test_room_server_deployment_builds_and_activates_the_native_voice_data_plane() -> None:
    powershell = (ROOT / "scripts" / "update-room-server.ps1").read_text(encoding="utf-8")
    remote = (ROOT / "scripts" / "deploy-room-server.sh").read_text(encoding="utf-8")

    assert "test_native_voice_relay.py" in powershell
    assert "AudioService/src/relay" in powershell
    assert "AudioService/src/network/NetworkPacket.hpp" in powershell
    # The relay and AudioService share the voice protocol and timing policy through this header.
    assert "AudioService/src/network/RoomAudioContract.hpp" in powershell
    assert "RoomAudioContract.hpp" in remote
    assert "NativeVoiceRelay.cpp" in remote
    assert "g++" in remote
    assert (
        "AD_VOICE_NATIVE_RELAY_EXECUTABLE=/opt/karaoke-room-server/bin/NativeVoiceRelay" in remote
    )
    assert "AmbientCapabilities=CAP_SYS_NICE" in remote
    assert "/proc/$relay_pid/task/*" in remote
    assert 'chrt -p "$thread_id"' in remote
    assert 'test -x "$root/bin/NativeVoiceRelay"' in remote


def test_room_server_deployment_avoids_the_oracle_ssh_qos_stall() -> None:
    powershell = (ROOT / "scripts" / "update-room-server.ps1").read_text(encoding="utf-8")

    assert powershell.count('"IPQoS=none"') == 3


@pytest.fixture
def deployment_sandbox(tmp_path: Path):
    bash = (
        Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe"
        if os.name == "nt"
        else Path(shutil.which("bash") or "/bin/bash")
    )
    if not bash.is_file():
        pytest.skip("A real Bash interpreter is required for deployment failure injection")
    stamp = "20261012-120000"
    root, temporary, config = (tmp_path / name for name in ("root", "tmp", "systemd"))
    stage = temporary / f"karaoke-room-server-deploy-{stamp}"
    original = {
        root / "backend/room_server_main.py": "old backend",
        root / "pyproject.toml": "old project",
        root / "bin/NativeVoiceRelay": "old native",
        config / "karaoke-room-server.service.d/native-relay.conf": "old service config",
    }
    for path, value in original.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value, encoding="utf-8")
    python = root / ".venv/bin/python"
    python.parent.mkdir(parents=True)
    python.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
    python.chmod(0o755)
    source = tmp_path / "package"
    for filename in (
        "backend/room_server_main.py",
        "backend/api/room_server_app.py",
        "AudioService/src/relay/NativeVoiceRelay.cpp",
        "AudioService/src/relay/NativeVoiceRelayMain.cpp",
        "AudioService/src/network/NetworkPacket.hpp",
        "AudioService/src/network/RoomAudioContract.hpp",
        "pyproject.toml",
    ):
        path = source / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("new version", encoding="utf-8")
    temporary.mkdir()
    archive = temporary / f"karaoke-room-server-{stamp}.tar.gz"
    with tarfile.open(archive, "w:gz") as package:
        for child in source.iterdir():
            package.add(child, arcname=child.name)
    proc = tmp_path / "proc"
    (proc / "123/task/123").mkdir(parents=True)
    script = (ROOT / "scripts/deploy-room-server.sh").read_text(encoding="utf-8")
    for original_path, sandbox in (
        ("/opt/karaoke-room-server", root),
        ("/tmp", temporary),
        ("/etc/systemd/system", config),
        ("/proc", proc),
    ):
        script = script.replace(original_path, _bash_path(sandbox))
    deployed_script = tmp_path / "deploy.sh"
    deployed_script.write_text(script, encoding="utf-8", newline="\n")
    state = tmp_path / "service-state"
    state.write_text("active", encoding="utf-8")
    mocks = tmp_path / "mocks.sh"
    mocks.write_text(
        r"""fail_once() {
    if [[ "$FAIL_AT" == "$1" && ! -e "$RC_SANDBOX/failed-once" ]]; then
        touch "$RC_SANDBOX/failed-once"
        return 1
    fi
}
sudo() { "$@"; }
sleep() { :; }
g++() { printf '#!/usr/bin/env bash\n# new native\nexit 0\n' > "${@: -1}"; command chmod 755 "${@: -1}"; }
mv() {
    if [[ "$1" == "$RC_STAGE/backend" ]]; then fail_once install-backend || return 1; fi
    command mv "$@"
}
cp() {
    if [[ "${FAIL_ROLLBACK:-}" == 1 && "${@: -2:1}" == *backup-* && -e "$RC_SANDBOX/failed-once" ]]; then
        return 1
    fi
    if [[ "$1" == "$RC_STAGE/pyproject.toml" ]]; then fail_once install-project || return 1; fi
    if [[ "$1" == "$RC_STAGE/NativeVoiceRelay" ]]; then fail_once install-native || return 1; fi
    command cp "$@"
}
chown() { fail_once ownership; }
systemctl() {
    case "$1" in
        stop) printf inactive > "$RC_SANDBOX/service-state" ;;
        start) fail_once start || return 1; printf active > "$RC_SANDBOX/service-state" ;;
        daemon-reload) fail_once daemon-reload ;;
        is-active) [[ "$(cat "$RC_SANDBOX/service-state")" == active ]] ;;
    esac
}
curl() {
    fail_once health || return 22
    printf '{"paths":{"/rooms/{room_id}/changes":{}}}\n'
}
pgrep() { fail_once pid || return 1; printf '123\n'; }
chrt() { fail_once scheduling || return 1; printf 'SCHED_RR\n'; }
""",
        encoding="utf-8",
        newline="\n",
    )
    environment = {
        **os.environ,
        "BASH_ENV": _bash_path(mocks),
        "RC_SANDBOX": _bash_path(tmp_path),
        "RC_STAGE": _bash_path(stage),
    }
    return bash, deployed_script, stamp, archive, environment, state, original


def _run_deployment(
    sandbox, failure: str = "", **overrides: str
) -> subprocess.CompletedProcess[str]:
    bash, script, stamp, archive, environment, *_ = sandbox
    return subprocess.run(
        [str(bash), str(script), stamp, _bash_path(archive)],
        env={**environment, "FAIL_AT": failure, **overrides},
        capture_output=True,
        text=True,
        timeout=30,
    )


@pytest.mark.parametrize(
    "failure",
    [
        "install-backend",
        "install-project",
        "install-native",
        "ownership",
        "daemon-reload",
        "pid",
        "start",
        "health",
        "scheduling",
    ],
)
def test_deployment_restores_the_running_version_after_any_activation_failure(
    deployment_sandbox, failure: str
) -> None:
    *_, state, original = deployment_sandbox
    result = _run_deployment(deployment_sandbox, failure)
    assert result.returncode != 0, result.stdout + result.stderr
    assert (state.parent / "failed-once").is_file(), result.stdout + result.stderr
    assert state.read_text(encoding="utf-8") == "active", result.stdout + result.stderr
    for path, expected in original.items():
        assert path.read_text(encoding="utf-8") == expected, result.stdout + result.stderr
    assert "ROOM_SERVER_ROLLBACK=restored" in result.stdout


def test_deployment_reports_an_unverified_rollback_instead_of_claiming_success(deployment_sandbox):
    result = _run_deployment(deployment_sandbox, "pid", FAIL_ROLLBACK="1")
    assert result.returncode != 0
    assert "ROOM_SERVER_ROLLBACK=failed" in result.stderr
    assert "ROOM_SERVER_ROLLBACK=restored" not in result.stdout


def test_deployment_restores_absence_of_optional_native_files(deployment_sandbox):
    *_, state, original = deployment_sandbox
    removed = [path for path in original if path.name in {"NativeVoiceRelay", "native-relay.conf"}]
    for path in removed:
        path.unlink()
    result = _run_deployment(deployment_sandbox, "pid")
    assert result.returncode != 0
    assert "ROOM_SERVER_ROLLBACK=restored" in result.stdout, result.stderr
    assert state.read_text(encoding="utf-8") == "active"
    assert all(not path.exists() for path in removed)


def test_successful_deployment_keeps_the_new_version(deployment_sandbox):
    *_, state, original = deployment_sandbox
    result = _run_deployment(deployment_sandbox)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "ROOM_SERVER_ROLLBACK=" not in result.stdout
    assert state.read_text(encoding="utf-8") == "active"
    assert all(path.read_text(encoding="utf-8") != old for path, old in original.items())


def test_reused_deployment_stamp_cannot_remove_another_attempts_stage(deployment_sandbox):
    _bash, _script, stamp, archive, _environment, state, _original = deployment_sandbox
    stage = archive.parent / f"karaoke-room-server-deploy-{stamp}"
    stage.mkdir()
    owned_by_other = stage / "other-attempt"
    owned_by_other.write_text("keep", encoding="utf-8")
    result = _run_deployment(deployment_sandbox)
    assert result.returncode != 0
    assert state.read_text(encoding="utf-8") == "active"
    assert owned_by_other.read_text(encoding="utf-8") == "keep"
