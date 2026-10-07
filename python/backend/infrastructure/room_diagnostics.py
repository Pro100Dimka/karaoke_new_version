from __future__ import annotations

import logging
import os
import shutil
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Mapping, Sequence

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
        line = dumps(
            {"at": moment.isoformat(), "participantId": participant_id, "values": dict(values)}
        )
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


class ProgramLog:
    """One bounded, append-only JSONL view of client, room and server events."""

    def __init__(
        self,
        path: Path,
        *,
        max_bytes: int = 128 * 1024 * 1024,
        max_peer_uploads_per_minute: int = 300,
        max_uploads_per_minute: int = 1200,
        max_peer_upload_bytes_per_minute: int = 32 * 1024 * 1024,
        max_upload_bytes_per_minute: int = 64 * 1024 * 1024,
        now: Callable[[], float] = time.time,
    ) -> None:
        self._path = path
        self._max_bytes = max_bytes
        self._max_peer_uploads = max_peer_uploads_per_minute
        self._max_uploads = max_uploads_per_minute
        self._max_peer_upload_bytes = max_peer_upload_bytes_per_minute
        self._max_upload_bytes = max_upload_bytes_per_minute
        self._now = now
        self._lock = threading.Lock()
        self._window_start = time.monotonic()
        self._peer_uploads: dict[str, tuple[int, int]] = {}
        self._total_uploads = 0
        self._total_upload_bytes = 0

    def append(
        self,
        client_id: str,
        entries: Sequence[Mapping[str, str]],
        *,
        rate_key: str | None = None,
    ) -> bool:
        """Append complete lines, or reject an oversized/rate-limited upload."""
        at = datetime.fromtimestamp(self._now(), timezone.utc).isoformat()
        payload = "".join(
            dumps({"at": at, "clientId": client_id, **entry}) + "\n" for entry in entries
        ).encode("utf-8")
        if not payload or len(payload) > self._max_bytes:
            return False
        with self._lock:
            if rate_key is not None:
                elapsed = time.monotonic() - self._window_start
                if elapsed >= 60:
                    self._window_start = time.monotonic()
                    self._peer_uploads.clear()
                    self._total_uploads = self._total_upload_bytes = 0
                peer_count, peer_bytes = self._peer_uploads.get(rate_key, (0, 0))
                if (
                    peer_count >= self._max_peer_uploads
                    or peer_bytes + len(payload) > self._max_peer_upload_bytes
                    or self._total_uploads >= self._max_uploads
                    or self._total_upload_bytes + len(payload) > self._max_upload_bytes
                ):
                    return False
                self._peer_uploads[rate_key] = (peer_count + 1, peer_bytes + len(payload))
                self._total_uploads += 1
                self._total_upload_bytes += len(payload)
            self._path.parent.mkdir(parents=True, exist_ok=True)
            size = self._path.stat().st_size if self._path.exists() else 0
            if size + len(payload) > self._max_bytes:
                self._keep_recent_lines(max(0, self._max_bytes // 2 - len(payload)), payload)
            else:
                with self._path.open("ab") as output:
                    output.write(payload)
        return True

    def _keep_recent_lines(self, retained_bytes: int, payload: bytes) -> None:
        """Atomically replace the file with the newest complete lines and the new upload."""
        temporary = self._path.with_suffix(".tmp")
        with self._path.open("rb") as previous, temporary.open("wb") as output:
            offset = max(0, self._path.stat().st_size - retained_bytes)
            previous.seek(offset)
            if offset:
                previous.readline()  # The first fragment may begin midway through a JSON line.
            shutil.copyfileobj(previous, output)
            output.write(payload)
        os.replace(temporary, self._path)


class ProgramLogHandler(logging.Handler):
    """Send the room server's own Python logs through the same serialized writer."""

    def __init__(self, log: ProgramLog) -> None:
        super().__init__()
        self._log = log

    def emit(self, record: logging.LogRecord) -> None:
        message = record.getMessage()
        if record.exc_info:
            message += "\n" + logging.Formatter().formatException(record.exc_info)
        try:
            self._log.append(
                "room-server",
                [
                    {
                        "timestamp": datetime.fromtimestamp(record.created, timezone.utc).isoformat(),
                        "source": record.name,
                        "level": record.levelname,
                        "message": message,
                    }
                ],
            )
        except OSError:
            self.handleError(record)
