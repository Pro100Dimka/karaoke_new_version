from __future__ import annotations

import html
import re
import socket
import threading
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from difflib import SequenceMatcher

from backend.domain_errors import DependencyError
from backend.lyrics.ports import LyricsCandidate
from backend.serialization import loads_object
from backend.songs.domain import Language, Song
from backend.text_normalization import normalize_catalog_identity, strip_annotations

Fetch = Callable[[str, float], str]

_SEARCH_ROW = re.compile(
    r"<tr>\s*<td>.*?<a[^>]*>(?P<artist>.*?)</a>.*?</td>\s*"
    r"<td>\s*<a\s+href=[\"'](?P<url>[^\"']+)[\"'][^>]*>(?P<title>.*?)</a>",
    re.IGNORECASE | re.DOTALL,
)
_JSON_LD = re.compile(
    r"<script[^>]+type=[\"']application/ld\+json[\"'][^>]*>(?P<data>.*?)</script>",
    re.IGNORECASE | re.DOTALL,
)
_LYRICS = re.compile(
    r'id=[\"\']tp-lyrics-original[\"\'][^>]*>\s*<div[^>]*>(?P<text>.*?)</div>',
    re.IGNORECASE | re.DOTALL,
)
_TAG = re.compile(r"<[^>]+>")
_BREAK = re.compile(r"<br\s*/?>", re.IGNORECASE)


def _http_get(url: str, timeout_seconds: float) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": "A&D-Voice/1"})
    with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
        return str(response.read().decode("utf-8", errors="replace"))


class TekstPesenokLyricsProvider:
    """Fallback catalog for songs missing from LRCLIB, using published page metadata."""

    provider_id = "TekstPesenok"

    def __init__(
        self,
        *,
        base_url: str = "https://tekst-pesenok.online",
        timeout_seconds: float = 8.0,
        fetch: Fetch = _http_get,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout_seconds
        self._fetch = fetch

    def search(
        self, song: Song, language: Language, cancel: threading.Event
    ) -> Sequence[LyricsCandidate]:
        del language
        title = strip_annotations(song.title)
        queries = (f"{song.artist} {title}".strip(), title)
        seen: set[str] = set()
        for query in queries:
            if cancel.is_set():
                return ()
            candidates: list[LyricsCandidate] = []
            for url in self._search_urls(query):
                if cancel.is_set():
                    return ()
                if url in seen:
                    continue
                seen.add(url)
                candidate = self._candidate(url)
                if candidate and _relevant(song, candidate):
                    candidates.append(candidate)
            if candidates:
                return tuple(candidates)
        return ()

    def _search_urls(self, query: str) -> tuple[str, ...]:
        page = self._fetch_page(f"{self._base_url}/?{urllib.parse.urlencode({'s': query})}")
        return tuple(
            urllib.parse.urljoin(f"{self._base_url}/", match.group("url"))
            for match in _SEARCH_ROW.finditer(page)
        )

    def _candidate(self, url: str) -> LyricsCandidate | None:
        page = self._fetch_page(url)
        metadata = next(
            (
                parsed
                for match in _JSON_LD.finditer(page)
                if (parsed := _metadata(match.group("data"))) is not None
            ),
            None,
        )
        if not metadata:
            return None
        title, artist, schema_lyrics = metadata
        lyrics_match = _LYRICS.search(page)
        lyrics = _clean_html_lyrics(lyrics_match.group("text")) if lyrics_match else schema_lyrics
        if not lyrics.strip():
            return None
        return LyricsCandidate(lyrics.strip(), title, artist, None, self.provider_id)

    def _fetch_page(self, url: str) -> str:
        try:
            return self._fetch(url, self._timeout)
        except urllib.error.HTTPError as exc:
            code = "ProviderRateLimited" if exc.code == 429 else "ProviderUnavailable"
            raise DependencyError(code, "Lyrics catalog request failed", status=exc.code) from exc
        except (socket.timeout, TimeoutError) as exc:
            raise DependencyError("ProviderTimeout", "Lyrics catalog request timed out") from exc
        except OSError as exc:
            raise DependencyError("ProviderUnavailable", "Lyrics catalog is unreachable") from exc


def _metadata(raw: str) -> tuple[str, str, str] | None:
    try:
        value = loads_object(html.unescape(raw))
    except (ValueError, TypeError):
        return None
    if value.get("@type") != "MusicRecording":
        return None
    artist = value.get("byArtist")
    recording = value.get("recordingOf")
    lyrics = recording.get("lyrics") if isinstance(recording, Mapping) else None
    title = value.get("name")
    artist_name = artist.get("name") if isinstance(artist, Mapping) else None
    text = lyrics.get("text") if isinstance(lyrics, Mapping) else None
    if not all(isinstance(item, str) and item.strip() for item in (title, artist_name, text)):
        return None
    return str(title).strip(), str(artist_name).strip(), str(text).strip()


def _clean_html_lyrics(value: str) -> str:
    lines = html.unescape(_TAG.sub("", _BREAK.sub("\n", value)))
    return "\n".join(line.strip() for line in lines.splitlines() if line.strip())


def _relevant(song: Song, candidate: LyricsCandidate) -> bool:
    def similar(left: str, right: str) -> bool:
        expected = normalize_catalog_identity(strip_annotations(left))
        actual = normalize_catalog_identity(strip_annotations(right))
        return bool(expected and actual) and SequenceMatcher(None, expected, actual).ratio() >= 0.84

    return similar(song.title, candidate.title) and similar(song.artist, candidate.artist)
