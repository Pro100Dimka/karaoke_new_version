from __future__ import annotations

from uuid import uuid4


class UuidGenerator:
    def new(self) -> str:
        return str(uuid4())
