from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_room_server_update_is_one_click_and_rolls_back_on_failed_health_check() -> None:
    launcher = (ROOT / "update-room-server.bat").read_text(encoding="utf-8")
    powershell = (ROOT / "scripts" / "update-room-server.ps1").read_text(encoding="utf-8")
    remote = (ROOT / "scripts" / "deploy-room-server.sh").read_text(encoding="utf-8")

    assert "update-room-server.ps1" in launcher
    assert 'local-secrets\\ssh\\karaoke_room_server' in powershell
    assert "icacls.exe" in powershell
    assert "test_room_server.py" in powershell
    assert "test_voice_relay.py" in powershell
    assert "backend.backup-$stamp" in remote
    assert "/health/ready" in remote
    assert "rollback" in remote


def test_local_secrets_directory_is_excluded_from_git() -> None:
    ignores = (ROOT / ".gitignore").read_text(encoding="utf-8")

    assert "/local-secrets/" in ignores
