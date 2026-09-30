from __future__ import annotations

import threading
import time
from typing import Callable, Iterable


class RoomActivity:
    """When each room last received a client request, so rooms nobody uses any more can be removed.

    An open app keeps its room alive by itself: it long-polls the room for changes. Reads made by the
    server's own sweep do not count. A room first seen by the sweep (after a restart, or created
    without a request naming it) counts from that moment.
    """

    def __init__(self, *, now: Callable[[], float] = time.monotonic) -> None:
        self._now = now
        self._lock = threading.Lock()
        self._seen: dict[str, float] = {}

    def touch(self, room_id: str) -> None:
        with self._lock:
            self._seen[room_id] = self._now()

    def idle(self, room_ids: Iterable[str], idle_seconds: float) -> tuple[str, ...]:
        now = self._now()
        with self._lock:
            current = tuple(room_ids)
            for room_id in current:
                self._seen.setdefault(room_id, now)
            for room_id in set(self._seen) - set(current):
                del self._seen[room_id]  # deleted elsewhere: forget it
            return tuple(
                room_id for room_id in current if now - self._seen[room_id] >= idle_seconds
            )
