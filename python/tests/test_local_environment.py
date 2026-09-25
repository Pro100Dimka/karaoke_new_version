from pathlib import Path

from backend.bootstrap import config as config_module
from backend.bootstrap.config import BackendConfig


def test_backend_accepts_os_selected_port(tmp_path, monkeypatch):
    monkeypatch.setenv("AD_VOICE_PORT", "0")
    assert BackendConfig.load(tmp_path / "data").port == 0


def test_configuration_tests_do_not_load_private_environment(tmp_path, monkeypatch):
    selected: list[Path] = []
    monkeypatch.setattr(
        config_module, "load_dotenv", lambda path, override: selected.append(Path(path))
    )
    BackendConfig.load(tmp_path / "data")
    assert str(selected[0]) == config_module.os.devnull


def test_desktop_can_select_the_bundled_environment_file(tmp_path, monkeypatch):
    bundled = tmp_path / "resources" / "python-app" / ".env"
    bundled.parent.mkdir(parents=True)
    bundled.write_text("AD_VOICE_AUDD_TOKEN=packaged-test-value\n", encoding="utf-8")
    monkeypatch.setenv("AD_VOICE_ENV_FILE", str(bundled))
    monkeypatch.delenv("AD_VOICE_AUDD_TOKEN", raising=False)
    load = config_module.load_dotenv
    selected: list[Path] = []

    def isolated_load(path, override):
        selected.append(Path(path))
        return load(path, override=override) if Path(path) == bundled else False

    monkeypatch.setattr(config_module, "load_dotenv", isolated_load)
    config = BackendConfig.load(tmp_path / "data")
    assert selected == [bundled]
    assert config.audd_api_token == "packaged-test-value"


def test_default_environment_is_loaded_from_the_project_secrets_directory(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.delenv("AD_VOICE_ENV_FILE", raising=False)
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
