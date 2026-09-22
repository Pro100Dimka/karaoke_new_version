from __future__ import annotations

import os
from pathlib import Path


def resolve_models_root(data_root: Path) -> Path:
    """AD_VOICE_MODELS overrides where models are read from, so a dev checkout and an installed build on
    the same machine can share one already-downloaded, checksum-verified model store instead of each
    needing its own multi-gigabyte copy. Falls back to the data root's own models folder when unset. This
    is the one place that decision is made -- both the main process and the isolated ai_worker subprocess
    call it, so they can never resolve a model to two different paths.
    """
    configured = os.getenv("AD_VOICE_MODELS")
    return Path(configured).expanduser().resolve() if configured else data_root / "models"
