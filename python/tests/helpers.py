from __future__ import annotations

import queue
import time
from pathlib import Path

from fastapi.testclient import TestClient

TERMINAL_STATES = {"Succeeded", "Failed", "Cancelled", "Interrupted"}


def import_song(
    client: TestClient,
    source: Path,
    *,
    title: str = "Song",
    artist: str = "Artist",
    language: str = "Auto",
    idempotency_key: str | None = None,
) -> dict[str, object]:
    headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
    response = client.post(
        "/songs",
        json={
            "sourcePath": str(source),
            "title": title,
            "artist": artist,
            "language": language,
        },
        headers=headers,
    )
    assert response.status_code == 201, response.text
    return response.json()


def wait_for_job(client: TestClient, job_id: str, timeout: float = 10.0) -> dict[str, object]:
    current = client.get(f"/jobs/{job_id}")
    assert current.status_code == 200, current.text
    payload = current.json()
    if payload["state"] in TERMINAL_STATES:
        return payload

    deadline = time.monotonic() + timeout
    with client.app.state.container.events.subscribe() as subscriber:
        current = client.get(f"/jobs/{job_id}")
        payload = current.json()
        if payload["state"] in TERMINAL_STATES:
            return payload
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(f"Job {job_id} did not finish before timeout")
            try:
                event = subscriber.get(timeout=remaining)
            except queue.Empty as exc:
                raise AssertionError(f"Job {job_id} did not finish before timeout") from exc
            if event.event_type != "job.changed" or event.data.get("jobId") != job_id:
                continue
            current = client.get(f"/jobs/{job_id}")
            payload = current.json()
            if payload["state"] in TERMINAL_STATES:
                return payload
