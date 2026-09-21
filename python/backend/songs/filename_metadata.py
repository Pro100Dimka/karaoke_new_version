from __future__ import annotations

import re
from dataclasses import replace
from pathlib import Path

from backend.songs.ports import MediaMetadata

UNKNOWN_ARTIST = "Unknown Artist"
_SEPARATORS = (" - ", " – ", " — ")

# Download sites stamp their address into names: "(zaycev.net)", "[Sefon.Pro]", "- www.muzlike.net", "new.muzikavsem.org".
_SITE = (
    r"(?:https?://)?(?:[\w-]+\.)+"
    r"(?:com|net|org|ru|ua|by|kz|su|pro|me|fm|info|biz|cc|to|io|tv|xyz|club|site|online|top|website|link|download)(?![\w-])"
)
_BRACKETED_SITE = re.compile(rf"\s*[(\[{{][^)\]}}]*{_SITE}[^)\]}}]*[)\]}}]", re.IGNORECASE)
_BARE_SITE = re.compile(rf"\s*[-–—_|]?\s*{_SITE}", re.IGNORECASE)


def clean_site_tags(value: str) -> str:
    """Removes download-site addresses (bracketed or bare) from a name; a name that is only an address is kept as is."""
    cleaned = _BARE_SITE.sub("", _BRACKETED_SITE.sub("", value))
    cleaned = " ".join(cleaned.split()).strip(" -–—_|")
    return cleaned or value


def split_artist_title(stem: str) -> tuple[str, str] | None:
    """``Artist - Title`` from a file name; None when the name has no such shape."""
    for separator in _SEPARATORS:
        artist, found, title = stem.partition(separator)
        if found and artist.strip() and title.strip():
            return artist.strip(), title.strip()
    return None


def with_filename_fallback(metadata: MediaMetadata, source: Path) -> MediaMetadata:
    """Fills the fields the file's own tags left empty from ``Artist - Title`` in its name.

    Embedded tags always win: the file name is used only for a missing artist and for a title that is
    itself just the file stem.
    """
    parts = split_artist_title(source.stem)
    if parts is not None:
        artist, title = parts
        artist_missing = metadata.artist == UNKNOWN_ARTIST
        title_missing = metadata.title == source.stem
        metadata = replace(
            metadata,
            artist=artist if artist_missing else metadata.artist,
            title=title if title_missing else metadata.title,
        )
    return replace(
        metadata,
        title=clean_site_tags(metadata.title),
        artist=clean_site_tags(metadata.artist),
        album=clean_site_tags(metadata.album) if metadata.album else metadata.album,
    )
