from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class StorageRoots:
    app: Path
    songs: Path
    models: Path
    cache: Path
    recordings: Path
    temp: Path
    quarantine: Path
    logs: Path
    recovery: Path
    database: Path

    @classmethod
    def under(cls, root: Path) -> "StorageRoots":
        root = root.expanduser().resolve()
        return cls(
            app=root,
            songs=root / "songs",
            models=root / "models",
            cache=root / "cache",
            recordings=root / "recordings",
            temp=root / "temp",
            quarantine=root / "quarantine",
            logs=root / "logs",
            recovery=root / "recovery",
            database=root / "app.db",
        )

    def directories(self) -> tuple[Path, ...]:
        return (
            self.app,
            self.songs,
            self.models,
            self.cache,
            self.recordings,
            self.temp,
            self.quarantine,
            self.logs,
            self.recovery,
        )
