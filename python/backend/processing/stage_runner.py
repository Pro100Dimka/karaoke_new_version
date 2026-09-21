from __future__ import annotations

from typing import Callable, TypeVar

from backend.processing.domain import CancellationPolicy, StageReport
from backend.processing.job_manager import JobContext
from backend.runtime import MonotonicClock

_T = TypeVar("_T")


class StageRunner:
    def __init__(self, timer: MonotonicClock) -> None:
        self._timer = timer

    def run(
        self,
        name: str,
        policy: CancellationPolicy,
        reports: list[StageReport],
        context: JobContext,
        action: Callable[[], _T],
        *,
        progress: float,
    ) -> _T:
        context.ensure_not_cancelled()
        started = self._timer.seconds()
        value = action()
        duration = max(0.0, self._timer.seconds() - started)
        reports.append(StageReport(name, duration, policy))
        context.progress(name, 1.0, progress)
        return value
