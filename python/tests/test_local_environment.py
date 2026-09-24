from pathlib import Path

from backend.bootstrap import config as config_module
from backend.bootstrap.config import BackendConfig


def test_default_environment_is_loaded_from_the_project_secrets_directory(
    tmp_path, monkeypatch
) -> None:
    loaded: list[object] = []
    monkeypatch.setattr(
        config_module,
        "load_dotenv",
        lambda path, override: loaded.append((path, override)),
    )

    BackendConfig.load(tmp_path / "data")

    assert loaded == [
        (
            config_module.Path(__file__).resolve().parents[2]
            / "local-secrets"
            / "env"
            / "python.env",
            False,
        )
    ]


def test_backend_loads_recognition_keys_from_local_environment(tmp_path: Path, monkeypatch) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text(
        "AD_VOICE_AUDD_TOKEN=from-file\nAD_VOICE_YOUTUBE_API_KEY=youtube-file\n", encoding="utf-8"
    )
    monkeypatch.delenv("AD_VOICE_AUDD_TOKEN", raising=False)
    monkeypatch.delenv("AD_VOICE_YOUTUBE_API_KEY", raising=False)

    config = BackendConfig.load(tmp_path / "data", env_file=env_file)

    assert config.audd_api_token == "from-file"
    assert config.youtube_api_key == "youtube-file"
