from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping, Sequence
from pathlib import Path
from difflib import SequenceMatcher

from aiohttp import ClientError
from shazamio import Shazam

from backend.songs.recognition import RecognizedSong, SongRecognitionProvider
from backend.songs.filename_metadata import split_artist_title
from backend.text_normalization import normalize_catalog_identity

Recognize = Callable[[Path], Awaitable[object]]
FindVideo = Callable[[str, str], str | None]


async def _recognize(source: Path) -> object:
    return await Shazam().recognize(str(source))


async def _await_result(result: Awaitable[object], timeout_seconds: float) -> object:
    return await asyncio.wait_for(result, timeout=timeout_seconds)


class ShazamRecognitionProvider(SongRecognitionProvider):
    """Identifies a song from its audio fingerprint, independent of its filename and tags."""

    def __init__(
        self,
        *,
        recognize: Recognize = _recognize,
        find_video: FindVideo | None = None,
        timeout_seconds: float = 15.0,
    ) -> None:
        self._recognize = recognize
        self._find_video = find_video
        self._timeout = timeout_seconds
        self._minimum_source_bytes = 128_000 if recognize is _recognize else 0

    def recognize(self, source: Path) -> RecognizedSong | None:
        if self._minimum_source_bytes and source.stat().st_size < self._minimum_source_bytes:
            return None
        try:
            payload: object = asyncio.run(
                _await_result(self._recognize(source), self._timeout)
            )
        except (OSError, RuntimeError, TimeoutError, TypeError, ValueError, ClientError):
            return None
        track = _mapping(_mapping(payload).get("track"))
        title, artist = _text(track.get("title")), _text(track.get("subtitle"))
        if not title or not artist or _conflicts_with_filename(source, artist, title):
            return None
        return RecognizedSong(
            title=title,
            artist=artist,
            album=_album(track),
            genre=_text(_mapping(track.get("genres")).get("primary")),
            artwork_url=_artwork(track),
            video_url=self._find_video(artist, title) if self._find_video else None,
            provider="Shazam",
            external_id=_text(track.get("key")) or _text(track.get("isrc")),
        )


def _album(track: Mapping[str, object]) -> str | None:
    sections = track.get("sections")
    for section in sections if isinstance(sections, Sequence) else ():
        metadata = _mapping(section).get("metadata")
        for item in metadata if isinstance(metadata, Sequence) else ():
            row = _mapping(item)
            if _text(row.get("title")) == "Album":
                return _text(row.get("text"))
    return None


def _conflicts_with_filename(source: Path, artist: str, title: str) -> bool:
    identity = split_artist_title(source.stem)
    if identity is None:
        return False
    expected_artist, expected_title = identity
    artist_match = _similarity(expected_artist, artist)
    title_match = _similarity(expected_title, title)
    return artist_match < 0.55 or title_match < 0.45


def _similarity(left: str, right: str) -> float:
    return SequenceMatcher(
        None, normalize_catalog_identity(left), normalize_catalog_identity(right)
    ).ratio()


def _artwork(track: Mapping[str, object]) -> str | None:
    images = _mapping(track.get("images"))
    artwork = _text(images.get("coverarthq")) or _text(images.get("coverart"))
    return artwork.replace("400x400cc", "1200x1200bb") if artwork else None


def _mapping(value: object) -> Mapping[str, object]:
    return value if isinstance(value, dict) else {}


def _text(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None
