from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from backend.api.policy import ApiPolicy
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

    @classmethod
    def load(cls, root: Path | None = None) -> "BackendConfig":
        configured_root = root or Path(os.getenv("AD_VOICE_DATA", "./data"))
        port = int(os.getenv("AD_VOICE_PORT", "8765"))
        if not 1 <= port <= 65535:
            raise ValueError("AD_VOICE_PORT must be between 1 and 65535")
        return cls(
            roots=StorageRoots.under(configured_root),
            resources=ResourceBudget(),
            packages=PackagePolicy(),
            api=ApiPolicy(),
            port=port,
            log_level=os.getenv("AD_VOICE_LOG_LEVEL", "INFO").upper(),
        )
