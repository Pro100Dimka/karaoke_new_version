from __future__ import annotations

import os
import sys
from pathlib import Path

import uvicorn

from backend.api.room_server_app import create_room_server_app
from backend.infrastructure.logging_config import configure_logging
from backend.storage.domain import StorageRoots


# The voice relay thread waits at most this long for the interpreter lock while HTTP threads run.
_THREAD_SWITCH_SECONDS = 0.001


def main() -> None:
    sys.setswitchinterval(_THREAD_SWITCH_SECONDS)
    roots = StorageRoots.under(Path(os.getenv("AD_VOICE_ROOM_SERVER_DATA", "./room-server-data")))
    configure_logging(roots.logs, os.getenv("AD_VOICE_ROOM_SERVER_LOG_LEVEL", "INFO"))
    uvicorn.run(
        create_room_server_app(
            room_database=roots.app / "rooms.sqlite3",
            project_root=roots.cache / "room-projects",
            diagnostics_root=roots.logs / "room-diagnostics",
        ),
        host="0.0.0.0",
        port=int(os.getenv("AD_VOICE_ROOM_SERVER_PORT", "8081")),
        log_level=os.getenv("AD_VOICE_ROOM_SERVER_LOG_LEVEL", "info").lower(),
    )


if __name__ == "__main__":
    main()
