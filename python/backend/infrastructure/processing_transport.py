from __future__ import annotations

import json
import shutil
import threading
import time
import zipfile
from pathlib import Path
from collections.abc import Callable, Mapping
from typing import Any

import httpx

from backend.domain_errors import ConflictError, DependencyError

MAX_FILE = 256 * 1024 * 1024


def write_bundle(path: Path, payload: Mapping[str, object], files: Mapping[str, Path]) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("payload.json", json.dumps(payload, ensure_ascii=False))
        for name, source in files.items():
            if Path(name).name != name or name == "payload.json":
                raise ValueError("Invalid processing artifact name")
            archive.write(source, name)
    if path.stat().st_size > MAX_FILE:
        raise DependencyError("ProcessingFileTooLarge", "Processing transfer exceeds 256 MiB")


def read_bundle(path: Path, directory: Path) -> dict[str, Any]:
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if (
            len(entries) > 8
            or len(set(names)) != len(names)
            or sum(entry.file_size for entry in entries) > 1024**3
            or any(Path(name).name != name or ":" in name or "\\" in name for name in names)
            or "payload.json" not in names
            or archive.getinfo("payload.json").file_size > 4 * 1024 * 1024
        ):
            raise ValueError("Invalid processing bundle")
        payload = json.loads(archive.read("payload.json"))
        if not isinstance(payload, dict):
            raise ValueError("Invalid processing response")
        for entry in entries:
            if entry.filename != "payload.json":
                with (
                    archive.open(entry) as source,
                    (directory / entry.filename).open("xb") as output,
                ):
                    shutil.copyfileobj(source, output, 1024 * 1024)
        return payload


class ProcessingTransport:
    def __init__(self, url: str, token: str) -> None:
        self.url = url.rstrip("/")
        self.client = httpx.Client(
            headers={"X-Processing-Key": token}, timeout=httpx.Timeout(60, connect=10)
        )

    def close(self) -> None:
        self.client.close()

    def request(self, method: str, route: str, **kwargs: Any) -> httpx.Response:
        response = self.client.request(method, self.url + route, **kwargs)
        self.check(response)
        return response

    @staticmethod
    def check(response: httpx.Response) -> None:
        if response.is_success:
            return
        try:
            detail = response.json().get("detail", "Remote processing is unavailable")
        except (ValueError, AttributeError):
            detail = "Remote processing is unavailable"
        codes = {
            403: "ProcessingAccessDenied",
            413: "ProcessingFileTooLarge",
            429: "ProcessingFreeLimitReached",
            507: "ProcessingStorageFull",
        }
        raise DependencyError(codes.get(response.status_code, "ProcessingUnavailable"), str(detail))

    def download(self, route: str, path: Path, headers: Mapping[str, str]) -> None:
        with self.client.stream("GET", self.url + route, headers=headers) as response:
            if not response.is_success:
                response.read()
                self.check(response)
            total = 0
            with path.open("xb") as output:
                for block in response.iter_bytes(1024 * 1024):
                    total += len(block)
                    if total > MAX_FILE:
                        raise DependencyError(
                            "ProcessingFileTooLarge", "Remote result exceeds 256 MiB"
                        )
                    output.write(block)

    def invoke(
        self,
        source: Path,
        result: Path,
        cancel: threading.Event,
        *,
        progress: Callable[[str, float, float], None] | None = None,
    ) -> None:
        if cancel.is_set():
            raise ConflictError("JobCancelled", "Processing was cancelled")
        with source.open("rb") as content:
            ticket = self.request(
                "POST",
                "/jobs",
                content=content,
                headers={"Content-Length": str(source.stat().st_size)},
            ).json()
        route = "/jobs/" + ticket["jobId"]
        headers = {"X-Job-Key": ticket["jobKey"]}
        deadline = time.monotonic() + 2 * 3600
        try:
            while not cancel.is_set():
                state = self.request("GET", route, headers=headers).json()
                update = state.get("progress")
                if progress is not None and isinstance(update, dict):
                    progress(
                        str(update["stage"]),
                        float(update["stageProgress"]),
                        min(0.98, float(update["overallProgress"])),
                    )
                if state["state"] == "done":
                    self.download(route + "/result", result, headers)
                    return
                if state["state"] in ["failed", "cancelled"]:
                    raise DependencyError(
                        "ProcessingFailed", state.get("error") or "Remote processing failed"
                    )
                if time.monotonic() >= deadline:
                    raise DependencyError(
                        "ProcessingTimeout", "Remote processing exceeded two hours"
                    )
                cancel.wait(2)
            raise ConflictError("JobCancelled", "Processing was cancelled")
        finally:
            try:
                self.request("DELETE", route, headers=headers)
            except (httpx.HTTPError, DependencyError):
                pass
