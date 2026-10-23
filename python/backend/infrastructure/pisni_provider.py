from __future__ import annotations

import html
import re
import threading
from collections.abc import Sequence

import httpx

from backend.domain_errors import DependencyError
from backend.lyrics.ports import LyricsCandidate
from backend.songs.domain import Language, Song
from backend.songs.filename_metadata import UNKNOWN_ARTIST, split_artist_title
from backend.text_normalization import normalize_catalog_identity, strip_annotations

_TEXT = re.compile(
    r'<div[^>]+class=["\'][^"\']*\bdesc-full\b[^"\']*["\'][^>]*>(.*?)</div>',
    re.IGNORECASE | re.DOTALL,
)
_ATTRIBUTE = re.compile(r'([\w:-]+)\s*=\s*(["\'])(.*?)\2', re.DOTALL)
_SLUG_SPELLING = str.maketrans({"х": "kh", "ї": "yi", "й": "y", "є": "ye"})


class PisniLyricsProvider:
    """Published Ukrainian lyrics, matched by the page's own artist/title metadata."""

    provider_id = "PisniUA"

    def __init__(self, *, transport: httpx.BaseTransport | None = None) -> None:
        self._transport = transport

    def search(
        self, song: Song, language: Language, cancel: threading.Event
    ) -> Sequence[LyricsCandidate]:
        del language
        if cancel.is_set() or not song.artist or song.artist == UNKNOWN_ARTIST:
            return ()
        parts = [
            "-".join(
                filter(
                    None,
                    map(
                        normalize_catalog_identity,
                        strip_annotations(value).casefold().translate(_SLUG_SPELLING).split(),
                    ),
                )
            )
            for value in (song.artist, song.title)
        ]
        if not all(parts):
            return ()
        try:
            with httpx.Client(
                transport=self._transport, timeout=8, follow_redirects=True
            ) as client:
                response = client.get(
                    f"https://pisni.ua/{'-'.join(parts)}", headers={"User-Agent": "A&D-Voice/1"}
                )
                if response.status_code == 404 or cancel.is_set():
                    return ()
                response.raise_for_status()
        except httpx.TimeoutException as exc:
            raise DependencyError("ProviderTimeout", "PisniUA request timed out") from exc
        except httpx.HTTPError as exc:
            raise DependencyError("ProviderUnavailable", "PisniUA request failed") from exc
        candidate = _candidate(response.text)
        return (candidate,) if candidate else ()


def _candidate(page: str) -> LyricsCandidate | None:
    identity: tuple[str, str] | None = None
    for attributes in re.findall(r"<meta\s+([^>]+)>", page, re.IGNORECASE):
        values = {
            name.lower(): html.unescape(value)
            for name, _quote, value in _ATTRIBUTE.findall(attributes)
        }
        if values.get("property") == "og:title":
            identity = split_artist_title(values.get("content", ""))
            break
    match = _TEXT.search(page)
    if identity is None or match is None:
        return None
    text = re.sub(r"<br\s*/?>|</p\s*>", "\n", match[1], flags=re.IGNORECASE)
    text = html.unescape(re.sub(r"<[^>]+>", "", text))
    lyrics = "\n".join(
        line.strip() for line in text.splitlines()
        if line.strip() and not re.fullmatch(
            r"\s*(?:Взято с сайта|Взято із сайту)\s*:?(?:\s+https?://\S+)?\s*",
            line, re.IGNORECASE,
        )
    )
    artist, title = identity
    return LyricsCandidate(lyrics, title, artist, None, "PisniUA") if lyrics else None
