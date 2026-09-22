from __future__ import annotations

import re
import socket
import threading
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable, Mapping, Sequence

from backend.domain_errors import DependencyError
from backend.lyrics.ports import LyricsCandidate
from backend.serialization import loads_list
from backend.songs.domain import Language, Song
from backend.songs.filename_metadata import UNKNOWN_ARTIST
from backend.text_normalization import strip_annotations

_TIMED_LINE = re.compile(r"^\s*\[(\d{1,2}):(\d{2}(?:\.\d+)?)]\s*(.*)$")
# A dash standing alone between words is punctuation, not a sung word, so it must not become a timed word.
_SPACED_DASH = re.compile(r"(?<=\s)[–—-](?=\s)")

Fetch = Callable[[str, float], str]


def _http_get(url: str, timeout_seconds: float) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": "A&D-Voice/1"})
    with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
        return str(response.read().decode("utf-8", errors="replace"))


class LrclibLyricsProvider:
    """Finds lyrics in the public LRCLIB catalog by title and artist; timed lines are reduced to plain text."""

    provider_id = "LRCLIB"

    def __init__(
        self,
        *,
        base_url: str = "https://lrclib.net",
        timeout_seconds: float = 8.0,
        fetch: Fetch = _http_get,
    ) -> None:
        self._base_url = base_url
        self._timeout = timeout_seconds
        self._fetch = fetch

    def search(
        self,
        song: Song,
        language: Language,
        cancel: threading.Event,
    ) -> Sequence[LyricsCandidate]:
        title = strip_annotations(song.title)
        artists = _artist_variants(song.artist)
        queries: list[Mapping[str, str]] = [
            {"track_name": title, "artist_name": artist} for artist in artists
        ]
        queries.append({"track_name": title})
        queries.append({"q": f"{artists[-1] if artists else ''} {title}".strip()})
        for query in queries:
            if cancel.is_set():
                return ()
            candidates = self._candidates(query)
            if candidates:
                return candidates
        return ()

    def _candidates(self, query: Mapping[str, str]) -> Sequence[LyricsCandidate]:
        url = f"{self._base_url}/api/search?{urllib.parse.urlencode(query)}"
        try:
            rows = loads_list(self._fetch(url, self._timeout))
        except urllib.error.HTTPError as exc:
            code = "ProviderRateLimited" if exc.code == 429 else "ProviderUnavailable"
            raise DependencyError(code, "LRCLIB request failed", status=exc.code) from exc
        except (socket.timeout, TimeoutError) as exc:
            raise DependencyError("ProviderTimeout", "LRCLIB request timed out") from exc
        except (OSError, ValueError) as exc:
            raise DependencyError("ProviderUnavailable", "LRCLIB is unreachable") from exc
        return tuple(item for row in rows if (item := _candidate(row)) is not None)


_ARTIST_SEPARATORS = re.compile(r"\s*(?:,|;|&|/|vs\.?|feat\.?|ft\.?|x)\s*", re.IGNORECASE)


def _artist_variants(artist: str) -> list[str]:
    """The artist as written and, for a collaboration, its first name: catalogs list a duet under one of the artists."""
    full = strip_annotations(artist).strip()
    if not full or full == UNKNOWN_ARTIST:
        return []
    first = _ARTIST_SEPARATORS.split(full)[0].strip()
    return [full] if not first or first == full else [full, first]


def _clean_line(line: str) -> str:
    return " ".join(_SPACED_DASH.sub("", line).split())


def _synced_lines(synced: str) -> list[tuple[float, str]]:
    lines: list[tuple[float, str]] = []
    for row in synced.splitlines():
        match = _TIMED_LINE.match(row)
        text = _clean_line(match[3]) if match else ""
        if match and text:
            lines.append((int(match[1]) * 60 + float(match[2]), text))
    return lines


def _candidate(row: object) -> LyricsCandidate | None:
    if not isinstance(row, dict):
        return None
    synced, plain = row.get("syncedLyrics"), row.get("plainLyrics")
    timed = _synced_lines(synced) if isinstance(synced, str) else []
    if timed:
        text = "\n".join(line for _, line in timed)
    else:
        text = (
            "\n".join(_clean_line(line) for line in plain.splitlines())
            if isinstance(plain, str)
            else ""
        )
    duration = row.get("duration")
    if not text.strip():
        return None
    return LyricsCandidate(
        text.strip(),
        str(row.get("trackName") or ""),
        str(row.get("artistName") or ""),
        float(duration) if isinstance(duration, (int, float)) else None,
        LrclibLyricsProvider.provider_id,
    )
