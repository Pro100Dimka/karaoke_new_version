"""Bounded file relay and persistent queue for the desktop processing worker."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import shutil
import sqlite3
import threading
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

ROOT = Path(os.environ["AD_VOICE_PROCESSING_DATA"]).resolve()
ROOT.mkdir(parents=True, exist_ok=True)
CLIENT_KEY = os.environ["AD_VOICE_PROCESSING_TOKEN"]
WORKER_KEY = os.environ["AD_VOICE_PROCESSING_WORKER_TOKEN"]
if min(len(CLIENT_KEY), len(WORKER_KEY)) < 32 or CLIENT_KEY == WORKER_KEY:
    raise RuntimeError(
        "Separate processing credentials of at least 32 characters are required"
    )
MAX_FILE = 256 * 1024 * 1024
MAX_STORAGE = 5 * 1024**3
# Deliberately below OCI's shared 10 TB allowance. Includes repeated downloads and control traffic.
MONTHLY_EGRESS = 100 * 1000**3
TTL = 24 * 3600
LOCK = threading.RLock()
app = FastAPI(title="A&D Voice Processing Queue", docs_url=None, redoc_url=None)


@contextmanager
def database() -> Iterator[sqlite3.Connection]:
    with LOCK, sqlite3.connect(ROOT / "queue.sqlite3", timeout=20) as db:
        db.row_factory = sqlite3.Row
        yield db


with database() as db:
    db.execute(
        "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, secret TEXT NOT NULL, "
        "state TEXT NOT NULL, created REAL NOT NULL, lease TEXT, deadline REAL, "
        "reserved INTEGER NOT NULL, error TEXT)"
    )
    db.execute(
        "CREATE TABLE IF NOT EXISTS traffic (month TEXT PRIMARY KEY, bytes INTEGER NOT NULL)"
    )
    db.execute(
        "CREATE TABLE IF NOT EXISTS worker (id INTEGER PRIMARY KEY, seen REAL NOT NULL)"
    )
    db.execute(
        "CREATE TABLE IF NOT EXISTS progress (job_id TEXT PRIMARY KEY, data TEXT NOT NULL)"
    )


class ProcessingProgress(BaseModel):
    stage: str = Field(min_length=1, max_length=128)
    stageProgress: float = Field(ge=0, le=1)
    overallProgress: float = Field(ge=0, le=1)


def authorize(request: Request, worker: bool = False) -> None:
    expected = WORKER_KEY if worker else CLIENT_KEY
    if not hmac.compare_digest(
        request.headers.get("X-Processing-Key", "").encode(), expected.encode()
    ):
        raise HTTPException(403, "Processing access denied")


def reserve_egress(size: int = 4096) -> None:
    month = datetime.now(timezone.utc).strftime("%Y-%m")
    with database() as db:
        db.execute("INSERT OR IGNORE INTO traffic VALUES (?, 0)", (month,))
        used = db.execute(
            "SELECT bytes FROM traffic WHERE month=?", (month,)
        ).fetchone()[0]
        if used + size > MONTHLY_EGRESS:
            raise HTTPException(
                429, "Free processing transfer allowance reached; try next month"
            )
        db.execute("UPDATE traffic SET bytes=bytes+? WHERE month=?", (size, month))


def cleanup() -> None:
    now = time.time()
    with database() as db:
        expired = db.execute(
            "SELECT id FROM jobs WHERE created<?", (now - TTL,)
        ).fetchall()
        for row in expired:
            shutil.rmtree(ROOT / row["id"], ignore_errors=True)
            db.execute("DELETE FROM jobs WHERE id=?", (row["id"],))
        db.execute("DELETE FROM progress WHERE job_id NOT IN (SELECT id FROM jobs)")
        db.execute(
            "UPDATE jobs SET state='failed', error='Processing worker disconnected' "
            "WHERE state='running' AND deadline<?",
            (now,),
        )


def job_for(request: Request, job_id: str, worker: bool = False) -> sqlite3.Row:
    authorize(request, worker)
    with database() as db:
        row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    proof = request.headers.get("X-Job-Key", "")
    expected = row["lease"] if worker and row else row["secret"] if row else ""
    if (
        not row
        or not expected
        or not hmac.compare_digest(
            (
                hashlib.sha256(proof.encode()).hexdigest() if not worker else proof
            ).encode(),
            expected.encode(),
        )
    ):
        raise HTTPException(404, "Processing job not found")
    assert isinstance(row, sqlite3.Row)
    return row


def content_size(request: Request) -> int:
    try:
        size = int(request.headers.get("Content-Length", "0"))
    except ValueError:
        size = 0
    if not 0 < size <= MAX_FILE:
        raise HTTPException(413, "Processing file must be between 1 byte and 256 MiB")
    return size


async def upload(request: Request, path: Path, expected: int) -> None:
    written = 0
    try:
        with path.open("xb") as output:
            async for block in request.stream():
                written += len(block)
                if written > expected:
                    raise HTTPException(413, "Processing file exceeds declared size")
                output.write(block)
        if written != expected:
            raise HTTPException(400, "Incomplete processing upload")
    except BaseException:
        path.unlink(missing_ok=True)
        raise


@app.get("/processing/health")
def health(request: Request) -> dict[str, object]:
    authorize(request)
    cleanup()
    reserve_egress()
    with database() as db:
        seen = db.execute("SELECT seen FROM worker WHERE id=1").fetchone()
        queued = db.execute(
            "SELECT count(*) FROM jobs WHERE state='queued'"
        ).fetchone()[0]
    return {
        "protocolVersion": 1,
        "workerOnline": bool(seen and time.time() - seen[0] < 60),
        "queued": queued,
        "monthlyTransferLimitBytes": MONTHLY_EGRESS,
        "fileLimitBytes": MAX_FILE,
    }


@app.post("/processing/jobs", status_code=201)
async def submit(request: Request) -> dict[str, str]:
    authorize(request)
    size = content_size(request)
    cleanup()
    reserve_egress()
    job_id, proof = uuid.uuid4().hex, secrets.token_urlsafe(32)
    with database() as db:
        reserved = db.execute("SELECT coalesce(sum(reserved),0) FROM jobs").fetchone()[
            0
        ]
        count = db.execute(
            "SELECT count(*) FROM jobs WHERE state IN ('queued','running','uploading')"
        ).fetchone()[0]
        if count >= 16 or reserved + size + MAX_FILE > MAX_STORAGE:
            raise HTTPException(429, "Processing queue is full")
        if shutil.disk_usage(ROOT).free < size + MAX_FILE + 2 * 1024**3:
            raise HTTPException(507, "Processing relay has insufficient free storage")
        db.execute(
            "INSERT INTO jobs (id,secret,state,created,lease,deadline,reserved,error) "
            "VALUES (?,?, 'uploading', ?,NULL,NULL,?,NULL)",
            (
                job_id,
                hashlib.sha256(proof.encode()).hexdigest(),
                time.time(),
                size + MAX_FILE,
            ),
        )
    directory = ROOT / job_id
    directory.mkdir()
    try:
        await upload(request, directory / "input.zip", size)
        with database() as db:
            db.execute("UPDATE jobs SET state='queued' WHERE id=?", (job_id,))
    except BaseException:
        with database() as db:
            db.execute("DELETE FROM jobs WHERE id=?", (job_id,))
        shutil.rmtree(directory, ignore_errors=True)
        raise
    return {"jobId": job_id, "jobKey": proof}


@app.get("/processing/jobs/{job_id}")
def status(request: Request, job_id: str) -> dict[str, object]:
    authorize(request)
    cleanup()
    row = job_for(request, job_id)
    reserve_egress()
    with database() as db:
        progress = db.execute(
            "SELECT data FROM progress WHERE job_id=?", (job_id,)
        ).fetchone()
    return {
        "state": row["state"],
        "error": row["error"],
        "progress": json.loads(progress[0]) if progress else None,
    }


@app.delete("/processing/jobs/{job_id}", status_code=204)
def cancel(request: Request, job_id: str) -> Response:
    row = job_for(request, job_id)
    reserve_egress()
    with database() as db:
        # The worker observes cancellation before another model step and during its subprocess.
        db.execute("UPDATE jobs SET state='cancelled' WHERE id=?", (job_id,))
        previous = db.execute(
            "SELECT reserved FROM jobs WHERE id=?", (job_id,)
        ).fetchone()
        if previous and row["state"] in ["queued", "done", "failed"]:
            shutil.rmtree(ROOT / job_id, ignore_errors=True)
            db.execute("UPDATE jobs SET reserved=0 WHERE id=?", (job_id,))
    return Response(status_code=204)


@app.get("/processing/jobs/{job_id}/result")
def result(request: Request, job_id: str) -> FileResponse:
    row = job_for(request, job_id)
    if row["state"] != "done":
        raise HTTPException(409, "Processing result is not ready")
    path = ROOT / job_id / "result.zip"
    reserve_egress(path.stat().st_size + 4096)
    return FileResponse(path, media_type="application/zip")


@app.post("/processing/worker/claim")
def claim(request: Request) -> dict[str, object]:
    authorize(request, True)
    cleanup()
    reserve_egress()
    with database() as db:
        db.execute("INSERT OR REPLACE INTO worker VALUES (1,?)", (time.time(),))
        # Only one worker and one model action at a time, including after accidental double launch.
        if db.execute("SELECT 1 FROM jobs WHERE state='running'").fetchone():
            return {"job": None}
        row = db.execute(
            "SELECT id FROM jobs WHERE state='queued' ORDER BY created LIMIT 1"
        ).fetchone()
        if not row:
            return {"job": None}
        lease = secrets.token_urlsafe(32)
        db.execute(
            "UPDATE jobs SET state='running',lease=?,deadline=? WHERE id=?",
            (lease, time.time() + 90, row["id"]),
        )
        return {"job": {"jobId": row["id"], "jobKey": lease}}


@app.get("/processing/worker/jobs/{job_id}/input")
def worker_input(request: Request, job_id: str) -> FileResponse:
    row = job_for(request, job_id, True)
    if row["state"] != "running":
        raise HTTPException(409, "Processing job is no longer running")
    path = ROOT / job_id / "input.zip"
    reserve_egress(path.stat().st_size + 4096)
    return FileResponse(path, media_type="application/zip")


@app.post("/processing/worker/jobs/{job_id}/heartbeat")
def heartbeat(
    request: Request, job_id: str, progress: ProcessingProgress | None = None
) -> dict[str, str]:
    row = job_for(request, job_id, True)
    reserve_egress()
    with database() as db:
        db.execute("UPDATE jobs SET deadline=? WHERE id=?", (time.time() + 90, job_id))
        if progress is not None:
            db.execute(
                "INSERT OR REPLACE INTO progress VALUES (?,?)",
                (job_id, progress.model_dump_json()),
            )
        db.execute("INSERT OR REPLACE INTO worker VALUES (1,?)", (time.time(),))
    return {"state": row["state"]}


@app.put("/processing/worker/jobs/{job_id}/result", status_code=204)
async def worker_result(request: Request, job_id: str) -> Response:
    row = job_for(request, job_id, True)
    if row["state"] != "running":
        raise HTTPException(409, "Processing job is no longer running")
    size = content_size(request)
    reserve_egress()
    await upload(request, ROOT / job_id / "result.zip", size)
    with database() as db:
        db.execute(
            "UPDATE jobs SET state='done' WHERE id=? AND state='running'", (job_id,)
        )
    return Response(status_code=204)


@app.post("/processing/worker/jobs/{job_id}/failed", status_code=204)
def worker_failed(request: Request, job_id: str) -> Response:
    job_for(request, job_id, True)
    reserve_egress()
    with database() as db:
        db.execute(
            "UPDATE jobs SET state='failed',error='Processing failed on the worker PC' "
            "WHERE id=? AND state='running'",
            (job_id,),
        )
    return Response(status_code=204)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8083, access_log=False)
