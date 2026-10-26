"""Download the installer's optional AI files with at most three simultaneous transfers."""
from __future__ import annotations

import argparse
import threading
import time
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from http.client import HTTPException
from pathlib import Path

from backend.ai.catalog import CATALOG
from backend.domain_errors import DomainError
from backend.infrastructure.hashing import sha256_file
from backend.infrastructure.http_downloader import HttpDownloader
from backend.infrastructure.torch_runtime import COMPLETE_MARKER, GPU_WHEELS, install_gpu


def remote_size(url: str) -> int:
    # Wheel sizes come from the server. HEAD failure must not prevent a working GET.
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=5) as response:
            return max(0, int(response.headers.get("Content-Length", "0")))
    except (OSError, ValueError, HTTPException):
        return 0


@dataclass
class Download:
    name: str
    url: str
    target: Path
    checksum: str
    size: int = 0
    received: int = 0
    state: str = "waiting"

    def progress(self, received: int) -> None:
        self.received = received

    def run(self, cancel: threading.Event) -> None:
        if cancel.is_set():
            return
        self.state = "verify"
        if self.target.is_file() and sha256_file(self.target) == self.checksum:
            self.size = self.received = self.target.stat().st_size
            self.state = "ready"
            return
        if not self.size:
            self.size = remote_size(self.url)
        partial = self.target.with_name(self.target.name + ".installer-part")
        try:
            self.state = "download"
            received = HttpDownloader().download(
                self.url, partial, timeout_seconds=60,
                max_bytes=self.size or 8 * 1024**3, cancel=cancel, progress=self.progress,
            )
            self.state = "verify"
            if self.size and received != self.size:
                raise ValueError(f"{self.name}: incomplete download")
            if sha256_file(partial) != self.checksum:
                raise ValueError(f"{self.name}: SHA-256 does not match")
            if cancel.is_set():
                return
            partial.replace(self.target)
            self.size = self.received = received
            self.state = "ready"
        finally:
            partial.unlink(missing_ok=True)


def report(downloads: list[Download], phase: str = "DOWNLOAD") -> None:
    """Small, ASCII, line-based messages consumed by Inno Setup's output callback."""
    mib = 1024 * 1024
    received = sum(item.received for item in downloads) // mib
    total = (
        max(1, sum(item.size for item in downloads) // mib)
        if all(item.size for item in downloads) else 0
    )
    ready = sum(item.state == "ready" for item in downloads)
    if phase == "DOWNLOAD" and any(item.state == "verify" for item in downloads):
        phase = "VERIFY"
    print(f"PROGRESS|{received}|{total}|{ready}|{len(downloads)}|{phase}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("profile", type=Path)
    parser.add_argument("--models", action="store_true")
    parser.add_argument("--gpu", type=Path)
    parser.add_argument("--cancel-file", type=Path, required=True)
    args = parser.parse_args()
    downloads = [
        Download(
            model.model_id, model.download_url,
            args.profile / "backend-data" / "models" / model.model_id / model.version / "model.bin",
            model.checksum, model.size,
        )
        for model in CATALOG if args.models
    ]
    gpu = args.gpu if args.gpu and not (args.gpu / COMPLETE_MARKER).is_file() else None
    gpu_downloads = [
        Download(wheel.file_name, wheel.url, gpu.parent / "downloads" / wheel.file_name, wheel.sha256)
        for wheel in GPU_WHEELS
    ] if gpu else []
    # Resolve the two server-reported wheel sizes first so the overall byte total stabilizes early.
    downloads = gpu_downloads + downloads
    return prepare(downloads, gpu, gpu_downloads, args.cancel_file)


def fetch_all(
    downloads: list[Download], pool: ThreadPoolExecutor, cancel: threading.Event, cancel_file: Path,
) -> bool:
    failed = False
    pending = {pool.submit(item.run, cancel): item for item in downloads}
    while pending:
        if cancel_file.exists():
            cancel.set()
        for future, item in list(pending.items()):
            if not future.done():
                continue
            del pending[future]
            try:
                future.result()
            except (OSError, ValueError, DomainError, HTTPException) as exc:
                item.state = "failed"
                failed = True
                message = f"{item.name}: {exc}".encode("ascii", "backslashreplace").decode()
                print(f"ERROR|{message}", flush=True)
        report(downloads)
        if pending:
            time.sleep(0.5)
    return failed


def prepare(
    downloads: list[Download], gpu: Path | None, gpu_downloads: list[Download], cancel_file: Path,
) -> int:
    cancel = threading.Event()
    with ThreadPoolExecutor(max_workers=3, thread_name_prefix="installer-download") as pool:
        failed = fetch_all(downloads, pool, cancel, cancel_file)
        if cancel.is_set() or cancel_file.exists():
            return 2
        if gpu and all(item.state == "ready" for item in gpu_downloads):
            # Extraction remains sequential; keep the UI responsive while the worker unpacks.
            report(downloads, "GPU")
            prepared = pool.submit(
                install_gpu, gpu, verified_wheels=[item.target for item in gpu_downloads],
            )
            while not prepared.done():
                time.sleep(0.5)
                report(downloads, "GPU")
            try:
                prepared.result()
            except (OSError, ValueError, zipfile.BadZipFile) as exc:
                print(f"ERROR|GPU: {str(exc).encode('ascii', 'backslashreplace').decode()}", flush=True)
                failed = True
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
