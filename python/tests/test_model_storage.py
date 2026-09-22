from __future__ import annotations

from pathlib import Path

import pytest

from backend.model_storage import resolve_models_root


def test_falls_back_to_the_data_roots_own_models_folder_when_unset(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("AD_VOICE_MODELS", raising=False)

    assert resolve_models_root(tmp_path) == tmp_path / "models"


def test_ad_voice_models_overrides_the_data_roots_own_folder(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    shared = tmp_path / "shared-models"
    monkeypatch.setenv("AD_VOICE_MODELS", str(shared))

    assert resolve_models_root(tmp_path / "profile-a") == shared.resolve()
