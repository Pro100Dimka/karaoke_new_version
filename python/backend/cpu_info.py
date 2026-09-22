from __future__ import annotations

import os

_FALLBACK_LOGICAL_CPU_COUNT = 4


def logical_cpu_count() -> int:
    """The machine's logical CPU count, the one place this is read so it is never guessed twice differently."""
    return os.cpu_count() or _FALLBACK_LOGICAL_CPU_COUNT
