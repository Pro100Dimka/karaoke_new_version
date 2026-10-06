from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


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
    assert 'AD_VOICE_NATIVE_RELAY_EXECUTABLE=/opt/karaoke-room-server/bin/NativeVoiceRelay' in remote
    assert "AmbientCapabilities=CAP_SYS_NICE" in remote
    assert '/proc/$relay_pid/task/*' in remote
    assert 'chrt -p "$thread_id"' in remote
    assert 'test -x "$root/bin/NativeVoiceRelay"' in remote


def test_room_server_deployment_avoids_the_oracle_ssh_qos_stall() -> None:
    powershell = (ROOT / "scripts" / "update-room-server.ps1").read_text(encoding="utf-8")

    assert powershell.count('"IPQoS=none"') == 3
