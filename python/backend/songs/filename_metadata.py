from __future__ import annotations

from dataclasses import replace
from pathlib import Path

from backend.songs.ports import MediaMetadata

UNKNOWN_ARTIST = "Unknown Artist"
_SEPARATORS = (" - ", " – ", " — ")


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
    if parts is None:
        return metadata
    artist, title = parts
    artist_missing = metadata.artist == UNKNOWN_ARTIST
    title_missing = metadata.title == source.stem
    return replace(
        metadata,
        artist=artist if artist_missing else metadata.artist,
        title=title if title_missing else metadata.title,
    )
