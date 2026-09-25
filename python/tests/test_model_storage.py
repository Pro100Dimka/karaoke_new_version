from __future__ import annotations

from pathlib import Path

import pytest

from backend.model_storage import resolve_models_root
from backend.infrastructure.local_storage import LocalModelStorage
from backend.storage.domain import StorageRoots
from backend.domain_errors import DomainError


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


@pytest.mark.parametrize(
    "value", ["../outside", "..\\outside", "C:relative", "nested/part", "NUL", "part:stream"]
)
@pytest.mark.parametrize("field", ["model_id", "version"])
def test_model_storage_rejects_unsafe_identity_components(tmp_path, value, field):
    storage = LocalModelStorage(StorageRoots.under(tmp_path))
    identity = {"model_id": "model", "version": "1", field: value}
    for target in (storage.final_path, storage.temporary_path):
        with pytest.raises(DomainError):
            target(**identity)


def test_download_staging_is_unique_and_on_the_destination_volume(tmp_path):
    storage = LocalModelStorage(StorageRoots.under(tmp_path))
    first, second = (storage.temporary_path("model", "1") for _ in range(2))
    assert first != second
    assert first.parent == second.parent == storage.final_path("model", "1").parent
