from __future__ import annotations

import os
from pathlib import Path

from backend.ai.catalog import ModelSpec
from backend.model_storage import resolve_models_root
from backend.storage.domain import StorageRoots


def model_file(spec: ModelSpec) -> Path:
    """Where the backend's model downloader published the verified weights (same layout as LocalModelStorage)."""
    roots = StorageRoots.under(Path(os.getenv("AD_VOICE_DATA", "./data")))
    models_root = resolve_models_root(roots.app)
    path = models_root / spec.model_id / spec.version / "model.bin"
    if not path.is_file():
        raise FileNotFoundError(f"Model {spec.model_id}:{spec.version} is not installed")
    return path
