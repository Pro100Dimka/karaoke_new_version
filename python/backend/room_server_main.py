from __future__ import annotations

import os
from pathlib import Path

import uvicorn

from backend.api.room_server_app import create_room_server_app
from backend.infrastructure.logging_config import configure_logging
from backend.storage.domain import StorageRoots


def main() -> None:
    roots = StorageRoots.under(Path(os.getenv("AD_VOICE_ROOM_SERVER_DATA", "./room-server-data")))
    configure_logging(roots.logs, os.getenv("AD_VOICE_ROOM_SERVER_LOG_LEVEL", "INFO"))
    uvicorn.run(
        create_room_server_app(
            room_database=roots.app / "rooms.sqlite3",
            project_root=roots.cache / "room-projects",
        ),
        host="0.0.0.0",
        port=int(os.getenv("AD_VOICE_ROOM_SERVER_PORT", "8081")),
        log_level=os.getenv("AD_VOICE_ROOM_SERVER_LOG_LEVEL", "info").lower(),
    )


if __name__ == "__main__":
    main()
