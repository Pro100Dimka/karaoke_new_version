from __future__ import annotations

from pathlib import Path

import pytest

from backend.ai.catalog import SEPARATION_MODEL
from backend.ai_worker.paths import model_file


def test_model_file_is_found_in_the_data_roots_own_models_folder(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("AD_VOICE_MODELS", raising=False)
    monkeypatch.setenv("AD_VOICE_DATA", str(tmp_path))
    weights = (
        tmp_path / "models" / SEPARATION_MODEL.model_id / SEPARATION_MODEL.version / "model.bin"
    )
    weights.parent.mkdir(parents=True)
    weights.write_bytes(b"weights")

    assert model_file(SEPARATION_MODEL) == weights


def test_model_file_honours_ad_voice_models_so_a_fresh_profile_reuses_a_shared_store(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # A dev profile with its own, empty AD_VOICE_DATA must still find models an installed build (or another
    # profile) already downloaded, the same way backend.bootstrap.config.BackendConfig.load() does -- the
    # subprocess that actually loads the model must resolve it identically to the main process, or a
    # profile with AD_VOICE_MODELS set but no local copy fails with "model not installed" despite one
    # being available.
    shared_models = tmp_path / "shared-models"
    weights = shared_models / SEPARATION_MODEL.model_id / SEPARATION_MODEL.version / "model.bin"
    weights.parent.mkdir(parents=True)
    weights.write_bytes(b"weights")
    monkeypatch.setenv("AD_VOICE_MODELS", str(shared_models))
    monkeypatch.setenv("AD_VOICE_DATA", str(tmp_path / "fresh-profile"))

    assert model_file(SEPARATION_MODEL) == weights


def test_model_file_raises_when_truly_not_installed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("AD_VOICE_MODELS", raising=False)
    monkeypatch.setenv("AD_VOICE_DATA", str(tmp_path))

    with pytest.raises(FileNotFoundError):
        model_file(SEPARATION_MODEL)
