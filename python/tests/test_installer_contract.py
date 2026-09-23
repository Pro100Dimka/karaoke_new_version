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
