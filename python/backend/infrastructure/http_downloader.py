from __future__ import annotations

import threading
import time
from collections.abc import Callable
import urllib.error
import urllib.request
from pathlib import Path

from backend.domain_errors import DependencyError, DomainError

_CHUNK_SIZE = 1024 * 1024


class HttpDownloader:
    def download(
        self,
        url: str,
        target: Path,
        *,
        timeout_seconds: float,
        max_bytes: int,
        cancel: threading.Event,
        progress: Callable[[int], None] | None = None,
    ) -> int:
        target.parent.mkdir(parents=True, exist_ok=True)
        downloaded = 0
        reported_at = 0.0
        try:
            with (
                urllib.request.urlopen(url, timeout=timeout_seconds) as response,
                target.open("wb") as stream,
            ):
                while chunk := response.read(_CHUNK_SIZE):
                    if cancel.is_set():
                        raise DomainError("DownloadCancelled", "Model download was cancelled", 499)
                    downloaded += len(chunk)
                    if downloaded > max_bytes:
                        raise DomainError(
                            "DownloadTooLarge", "Download exceeded declared size limit", 400
                        )
                    stream.write(chunk)
                    now = time.monotonic()
                    if progress and now - reported_at >= 0.2:
                        progress(downloaded)
                        reported_at = now
        except urllib.error.HTTPError as exc:
            raise DependencyError(
                "ModelDownloadFailed", "Model server returned an HTTP error", status=exc.code
            ) from exc
        except urllib.error.URLError as exc:
            raise DependencyError(
                "ModelDownloadFailed", "Model download network request failed"
            ) from exc
        if progress:
            progress(downloaded)
        return downloaded
