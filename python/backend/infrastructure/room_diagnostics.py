from __future__ import annotations

import shutil
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Mapping

from backend.serialization import dumps

_safe_room_component = frozenset("0123456789abcdefghijklmnopqrstuvwxyz-")


class RoomDiagnosticsLog:
    """Append-only log of the audio diagnostics each room participant uploads while in a room.

    It lets a developer see every computer of a room side by side over time, without asking the
    participants to copy reports. One JSON line per upload, one file per room and UTC day. Storage is
    bounded: a room stops logging at ``max_bytes_per_room`` a day, and days older than
    ``retention_days`` are removed. Numbers only: no audio, recordings or file contents.
    """

    def __init__(
        self,
        root: Path,
        *,
        max_bytes_per_room: int = 20 * 1024 * 1024,
        retention_days: int = 7,
        now: Callable[[], float] = time.time,
    ) -> None:
        self._root = root
        self._max_bytes = max_bytes_per_room
        self._retention_seconds = retention_days * 86_400
        self._now = now
        self._lock = threading.Lock()

    def append(self, room_id: str, participant_id: str, values: Mapping[str, str]) -> bool:
        """Records one upload; False when the room id is unsafe or today's file is full."""
        if not room_id or not set(room_id) <= _safe_room_component:
            return False
        moment = datetime.fromtimestamp(self._now(), timezone.utc)
        line = dumps({"at": moment.isoformat(), "participantId": participant_id, "values": dict(values)})
        target = self._root / room_id / f"{moment:%Y-%m-%d}.jsonl"
        with self._lock:
            if not target.exists():
                self._remove_expired_rooms()  # a new day: the natural moment to clean up
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists() and target.stat().st_size + len(line) + 1 > self._max_bytes:
                return False
            with target.open("a", encoding="utf-8") as output:
                output.write(line + "\n")
        return True

    def _remove_expired_rooms(self) -> None:
        """Removes rooms whose newest log is older than the retention period (lock held)."""
        if not self._root.is_dir():
            return
        cutoff = self._now() - self._retention_seconds
        for room in self._root.iterdir():
            newest = max((item.stat().st_mtime for item in room.glob("*.jsonl")), default=0.0)
            if newest < cutoff:
                shutil.rmtree(room, ignore_errors=True)
