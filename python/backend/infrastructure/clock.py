from __future__ import annotations

import time
from datetime import UTC, datetime


class UtcClock:
    def now(self) -> datetime:
        return datetime.now(UTC)


class SystemMonotonicClock:
    def seconds(self) -> float:
        return time.monotonic()
