from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ModelDownloadPolicy:
    timeout_seconds: float = 600.0
    safety_margin_bytes: int = 256 * 1024 * 1024

    def required_disk_bytes(self, model_size: int) -> int:
        return model_size * 2 + self.safety_margin_bytes
