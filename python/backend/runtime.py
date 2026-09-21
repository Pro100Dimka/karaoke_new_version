from __future__ import annotations

from datetime import datetime
from typing import Protocol


class Clock(Protocol):
    def now(self) -> datetime: ...


class MonotonicClock(Protocol):
    def seconds(self) -> float: ...


class IdGenerator(Protocol):
    def new(self) -> str: ...
