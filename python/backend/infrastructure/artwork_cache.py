"""
A song's recognised cover, kept on disk. The library used to load every cover straight from the
recognition service's CDN (1200×1200 for a 290 px card) on every start: no covers offline, a request
to a third party for each song each time, and ~1.4 megapixels decoded per card. The first request
downloads a card-sized copy into the cache; later ones are served from disk.
"""

from __future__ import annotations

import hashlib
import os
import re
from contextlib import suppress
from pathlib import Path
from tempfile import NamedTemporaryFile
from types import MappingProxyType

import httpx

# Apple's artwork CDN encodes the size in the file name; a card never needs more than this.
_MZSTATIC_SIZE = re.compile(r"/\d+x\d+(?:bb|cc)?\.(jpg|jpeg|png|webp)$", re.IGNORECASE)
_CARD_SIZE = "600x600bb"
_MAXIMUM_BYTES = 8 * 1024 * 1024
_EXTENSIONS = MappingProxyType({"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"})
_TIMEOUT_SECONDS = 10.0


def card_sized(url: str) -> str:
    if "mzstatic.com" not in url:
        return url
    return _MZSTATIC_SIZE.sub(lambda match: f"/{_CARD_SIZE}.{match.group(1)}", url)


class ArtworkCache:
    def __init__(self, cache_dir: Path, transport: httpx.BaseTransport | None = None) -> None:
        self._cache_dir = cache_dir
        self._transport = transport

    def path_for(self, url: str) -> Path | None:
        """The cover file for `url`, downloading it once; None when it cannot be had."""
        return _cached_artwork(self._cache_dir, url, self._transport)


def _cached_artwork(
    cache_dir: Path, url: str, transport: httpx.BaseTransport | None
) -> Path | None:
    if not url.startswith(("https://", "http://")):
        return None
    key = hashlib.sha256(url.encode("utf-8")).hexdigest()
    temporary: Path | None = None
    try:
        cached = next(
            (
                path
                for path in cache_dir.glob(f"{key}.*")
                if path.suffix != ".tmp" and path.is_file()
            ),
            None,
        )
        if cached is not None:
            return cached
        downloaded = _download_artwork(url, transport)
        if downloaded is None:
            return None
        content, extension = downloaded
        target = cache_dir / f"{key}{extension}"
        cache_dir.mkdir(parents=True, exist_ok=True)
        with NamedTemporaryFile(
            dir=cache_dir, prefix=f"{key}.", suffix=".tmp", delete=False
        ) as file:
            temporary = Path(file.name)
        temporary.write_bytes(content)
        _publish_artwork(temporary, target)
        return target
    except (httpx.HTTPError, httpx.InvalidURL, OSError):
        return None
    finally:
        if temporary is not None:
            with suppress(OSError):
                temporary.unlink(missing_ok=True)


def _publish_artwork(temporary: Path, target: Path) -> None:
    try:
        os.replace(temporary, target)
    except OSError:
        # A completed concurrent publication is already a valid cache hit.
        if not target.is_file():
            raise


def _download_artwork(
    url: str, transport: httpx.BaseTransport | None
) -> tuple[bytearray, str] | None:
    with httpx.Client(
        transport=transport, timeout=_TIMEOUT_SECONDS, follow_redirects=True
    ) as client:
        with client.stream("GET", card_sized(url)) as response:
            extension = _EXTENSIONS.get(
                response.headers.get("content-type", "").split(";")[0].strip()
            )
            if not response.is_success or extension is None:
                return None
            content = bytearray()
            for chunk in response.iter_bytes(chunk_size=64 * 1024):
                if len(content) + len(chunk) > _MAXIMUM_BYTES:
                    return None
                content.extend(chunk)
            return content, extension
