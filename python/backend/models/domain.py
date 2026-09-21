from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime
from enum import StrEnum
from pathlib import Path

from backend.ai.domain import AiCapability


class ModelState(StrEnum):
    MISSING = "Missing"
    DOWNLOADING = "Downloading"
    VERIFYING = "Verifying"
    READY = "Ready"
    FAILED = "Failed"
    UPDATE_AVAILABLE = "ModelUpdateAvailable"


class ComputeMode(StrEnum):
    AUTO = "Auto"
    CUDA = "CUDA"
    CPU = "CPU"


@dataclass(frozen=True, slots=True)
class AiModel:
    model_id: str
    purpose: AiCapability
    version: str
    size: int
    checksum: str
    state: ModelState
    selected: bool
    updated_at: datetime
    local_path: Path | None = None
    download_url: str | None = None

    def with_state(
        self, state: ModelState, now: datetime, local_path: Path | None = None
    ) -> "AiModel":
        return replace(self, state=state, updated_at=now, local_path=local_path or self.local_path)
