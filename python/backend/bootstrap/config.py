from __future__ import annotations

import os
from dataclasses import dataclass, replace
from pathlib import Path

from dotenv import load_dotenv

from backend.api.policy import ApiPolicy
from backend.model_storage import resolve_models_root
from backend.packages.policy import PackagePolicy
from backend.processing.policies import ResourceBudget
from backend.storage.domain import StorageRoots


@dataclass(frozen=True, slots=True)
class BackendConfig:
    roots: StorageRoots
    resources: ResourceBudget
    packages: PackagePolicy
    api: ApiPolicy
    host: str = "127.0.0.1"
    port: int = 8765
    log_level: str = "INFO"
    audd_api_token: str | None = None
    youtube_api_key: str | None = None

    @classmethod
    def load(cls, root: Path | None = None, env_file: Path | None = None) -> "BackendConfig":
        load_dotenv(
            env_file
            or Path(
                os.getenv("AD_VOICE_ENV_FILE")
                or Path(__file__).parents[3] / "local-secrets" / "env" / "python.env"
            ),
            override=False,
        )
        configured_root = root or Path(os.getenv("AD_VOICE_DATA", "./data"))
        roots = StorageRoots.under(configured_root)
        roots = replace(roots, models=resolve_models_root(roots.app))
        port = int(os.getenv("AD_VOICE_PORT", "8765"))
        if not 0 <= port <= 65535:
            raise ValueError("AD_VOICE_PORT must be between 0 and 65535 (0 selects a free port)")
        return cls(
            roots=roots,
            resources=ResourceBudget(),
            packages=PackagePolicy(),
            api=ApiPolicy(),
            port=port,
            log_level=os.getenv("AD_VOICE_LOG_LEVEL", "INFO").upper(),
            audd_api_token=os.getenv("AD_VOICE_AUDD_TOKEN") or None,
            youtube_api_key=os.getenv("AD_VOICE_YOUTUBE_API_KEY") or None,
        )
