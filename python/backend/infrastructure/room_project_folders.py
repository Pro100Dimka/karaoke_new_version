from __future__ import annotations

import shutil
from pathlib import Path
from typing import Callable


class RoomProjectFolders:
    """
    The song archives uploaded into rooms, one folder per room. They are only needed while their
    room exists: a room's folder goes with the room, and folders of rooms that no longer exist
    (left from before this cleanup, or from a crash) are removed by the housekeeping sweep.
    """

    def __init__(self, root: Path) -> None:
        self.root = root

    def remove(self, room_id: str) -> None:
        folder = self.root / room_id
        if folder.parent == self.root:
            shutil.rmtree(folder, ignore_errors=True)

    def remove_orphans(self, live_room_ids: Callable[[], tuple[str, ...]]) -> None:
        """Removes the folders of rooms that do not exist."""
        if not self.root.is_dir():
            return
        # Folders are listed before the rooms: a folder is only made for a room that already
        # exists, so a room created meanwhile is either in the list or has no folder yet.
        folders = [path for path in self.root.iterdir() if path.is_dir()]
        live = set(live_room_ids())
        for folder in folders:
            if folder.name not in live:
                shutil.rmtree(folder, ignore_errors=True)
