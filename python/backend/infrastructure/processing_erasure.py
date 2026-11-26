from __future__ import annotations

import shutil
import sqlite3
from pathlib import Path

from backend.domain_errors import DomainError


def processing_privacy_schema(db: sqlite3.Connection) -> None:
    db.execute("PRAGMA secure_delete=ON")
    if "owner" not in {row[1] for row in db.execute("PRAGMA table_info(jobs)")}:
        if db.execute("SELECT 1 FROM jobs LIMIT 1").fetchone():
            raise RuntimeError("Clear the legacy processing queue before upgrading privacy storage")
        db.execute("ALTER TABLE jobs ADD COLUMN owner TEXT NOT NULL DEFAULT ''")
    db.execute("CREATE TABLE IF NOT EXISTS privacy_owners (participant TEXT PRIMARY KEY)")
    db.execute(
        "CREATE TABLE IF NOT EXISTS privacy_erasures "
        "(participant TEXT PRIMARY KEY, completed INTEGER NOT NULL DEFAULT 0)"
    )


def acknowledge_processing_erasure(db: sqlite3.Connection, root: Path, participant: str) -> None:
    if not db.execute(
        "SELECT 1 FROM privacy_erasures WHERE participant=?", (participant,)
    ).fetchone():
        raise DomainError("ErasureNotFound", "No processing erasure was requested", 404)
    for (job_id,) in db.execute("SELECT id FROM jobs WHERE owner=?", (participant,)).fetchall():
        directory = root / job_id
        if directory.exists():
            shutil.rmtree(directory)
        db.execute("DELETE FROM progress WHERE job_id=?", (job_id,))
    db.execute("DELETE FROM jobs WHERE owner=?", (participant,))
    db.execute("DELETE FROM privacy_owners WHERE participant=?", (participant,))
    db.execute("UPDATE privacy_erasures SET completed=1 WHERE participant=?", (participant,))


class ProcessingErasure:
    def __init__(self, root: Path) -> None:
        self.root = root

    def erase(self, participants: tuple[str, ...]) -> None:
        database = self.root / "queue.sqlite3"
        if not database.exists():
            return
        with sqlite3.connect(database, timeout=20) as db:
            processing_privacy_schema(db)
            for participant in participants:
                known = db.execute(
                    "SELECT 1 FROM privacy_owners WHERE participant=?", (participant,)
                ).fetchone()
                db.execute(
                    "INSERT OR IGNORE INTO privacy_erasures VALUES (?,?)",
                    (participant, int(not known)),
                )
                db.execute("UPDATE jobs SET state='cancelled' WHERE owner=?", (participant,))
            pending = any(
                db.execute(
                    "SELECT 1 FROM privacy_erasures WHERE participant=? AND completed=0",
                    (participant,),
                ).fetchone()
                for participant in participants
            )
        if pending:
            raise DomainError(
                "ProcessingErasurePending",
                "Waiting for the processing computer to confirm erasure",
                409,
            )
