"""Record source provenance locally without changing media extraction or playback."""

from __future__ import annotations

import logging
import os
import re
import sqlite3
import time
from contextlib import closing
from pathlib import Path

from backend.serialization import dumps, loads_object

logger = logging.getLogger(__name__)


def record_source(video_id: str, channel_id: str) -> None:
    root = os.getenv("AD_VOICE_DATA")
    if (
        not root
        or re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id) is None
        or re.fullmatch(r"UC[A-Za-z0-9_-]{22}", channel_id) is None
    ):
        return
    cache = Path(root) / "cache"
    now = int(time.time())
    evidence: dict[str, object] = {}
    status = "unconfirmed"
    try:
        file = cache / "source-registry.json"
        if file.stat().st_size <= 8 * 1024 * 1024:
            registry = loads_object(file.read_text(encoding="utf-8"))
            for entry in registry.get("channels", []):
                if isinstance(entry, dict) and entry.get("channelId") == channel_id:
                    evidence = entry
                    checked = entry.get("checkedAt", 0)
                    if isinstance(checked, int) and 0 <= now - checked <= 30 * 86400:
                        status = "confirmed"
                    else:
                        status = "stale"
                    break
    except (OSError, ValueError, TypeError):
        pass
    try:
        cache.mkdir(parents=True, exist_ok=True)
        with (
            closing(sqlite3.connect(cache / "youtube-sources.sqlite3", timeout=0.05)) as connection,
            connection,
        ):
            connection.execute(
                "CREATE TABLE IF NOT EXISTS observations ("
                "video_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, "
                "observed_at INTEGER NOT NULL, status TEXT NOT NULL, evidence TEXT NOT NULL)"
            )
            connection.execute(
                "INSERT OR REPLACE INTO observations VALUES (?, ?, ?, ?, ?)",
                (video_id, channel_id, now, status, dumps(evidence)),
            )
            connection.execute(
                "DELETE FROM observations WHERE video_id NOT IN "
                "(SELECT video_id FROM observations ORDER BY observed_at DESC LIMIT 1000)"
            )
    except (OSError, sqlite3.Error):
        logger.debug("Source observation could not be saved", exc_info=True)
