from __future__ import annotations

import threading
from pathlib import Path
from typing import Protocol, Sequence

from backend.ai.domain import AiCapability, RequiredModel
from backend.models.domain import AiModel


class ModelRepository(Protocol):
    def get(self, model_id: str, version: str) -> AiModel | None: ...

    def add_or_update(self, model: AiModel) -> None: ...

    def list(self, purpose: AiCapability | None = None) -> Sequence[AiModel]: ...

    def select(self, model_id: str, version: str) -> AiModel: ...

    def missing(self, required: Sequence[RequiredModel]) -> Sequence[RequiredModel]: ...


class Downloader(Protocol):
    def download(
        self,
        url: str,
        target: Path,
        *,
        timeout_seconds: float,
        max_bytes: int,
        cancel: threading.Event,
    ) -> int: ...
