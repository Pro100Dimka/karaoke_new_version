from __future__ import annotations

import mimetypes
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from difflib import SequenceMatcher
from pathlib import Path
from typing import Callable, Mapping

from backend.songs.filename_metadata import split_artist_title
from backend.songs.recognition import RecognizedSong, SongRecognitionProvider
from backend.serialization import loads_object
from backend.text_normalization import normalize_catalog_identity

JsonObject = Mapping[str, object]
Post = Callable[[str, dict[str, str], Path, float], object]
FindVideo = Callable[[str, str], str | None]
Get = Callable[[urllib.request.Request, float], bytes]


def _get(request: urllib.request.Request, timeout_seconds: float) -> bytes:
    with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
        return bytes(response.read())


def _multipart_post(
    url: str, fields: dict[str, str], file_path: Path, timeout_seconds: float
) -> object:
    boundary = f"----ADVoice{uuid.uuid4().hex}"
    body = bytearray()
    for name, value in fields.items():
        body.extend(f"--{boundary}\r\n".encode())
        body.extend(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        body.extend(value.encode())
        body.extend(b"\r\n")
    mime = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    body.extend(f"--{boundary}\r\n".encode())
    body.extend(
        f'Content-Disposition: form-data; name="file"; filename="{file_path.name}"\r\n'.encode()
    )
    body.extend(f"Content-Type: {mime}\r\n\r\n".encode())
    body.extend(file_path.read_bytes())
    body.extend(f"\r\n--{boundary}--\r\n".encode())
    request = urllib.request.Request(
        url,
        data=bytes(body),
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "User-Agent": "A&D-Voice/1",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
        return loads_object(response.read().decode("utf-8"))


class YoutubeVideoFinder:
    def __init__(
        self,
        api_key: str | None,
        timeout_seconds: float = 7.0,
        get: Get = _get,
    ) -> None:
        self._api_key = api_key
        self._timeout = timeout_seconds
        self._get = get

    def __call__(self, artist: str, title: str) -> str | None:
        return (
            self._official(artist, title) if self._api_key else self._public_search(artist, title)
        )

    def _official(self, artist: str, title: str) -> str | None:
        query = urllib.parse.urlencode(
            {
                "part": "snippet",
                "maxResults": "1",
                "q": f"{artist} {title} official music video",
                "type": "video",
                "videoEmbeddable": "true",
                "key": self._api_key or "",
            }
        )
        request = urllib.request.Request(
            f"https://www.googleapis.com/youtube/v3/search?{query}",
            headers={"User-Agent": "A&D-Voice/1"},
        )
        try:
            payload = loads_object(self._get(request, self._timeout).decode("utf-8"))
        except (OSError, TimeoutError, ValueError, urllib.error.URLError):
            return None
        if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
            return None
        items = payload["items"]
        first = items[0] if items else None
        identity = first.get("id") if isinstance(first, dict) else None
        video_id = identity.get("videoId") if isinstance(identity, dict) else None
        return f"https://www.youtube.com/watch?v={video_id}" if isinstance(video_id, str) else None

    def _public_search(self, artist: str, title: str) -> str | None:
        query = urllib.parse.urlencode({"search_query": f"{artist} {title} official music video"})
        request = urllib.request.Request(
            f"https://www.youtube.com/results?{query}",
            headers={"User-Agent": "Mozilla/5.0 (A&D Voice song lookup)"},
        )
        try:
            payload = self._get(request, self._timeout)
        except (OSError, TimeoutError, urllib.error.URLError):
            return None
        matches = list(
            dict.fromkeys(
                item.decode("ascii")
                for item in re.findall(rb'"videoId":"([A-Za-z0-9_-]{11})"', payload)
            )
        )[:8]
        return self._best_public_candidate(matches, artist, title)

    def _best_public_candidate(
        self, video_ids: list[str], artist: str, title: str
    ) -> str | None:
        worker_count = min(4, len(video_ids))
        if not worker_count:
            return None
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            results = list(
                executor.map(
                    lambda item: self._public_candidate(item, artist, title), video_ids
                )
            )
        ranked = [(score, item) for score, item, _ in results if score is not None]
        metadata_responses = sum(responded for _, _, responded in results)
        if ranked:
            return f"https://www.youtube.com/watch?v={max(ranked)[1]}"
        if video_ids and metadata_responses == 0:
            return f"https://www.youtube.com/watch?v={video_ids[0]}"
        return None

    def _public_candidate(
        self, video_id: str, artist: str, title: str
    ) -> tuple[int | None, str, bool]:
        query = urllib.parse.urlencode(
            {"url": f"https://www.youtube.com/watch?v={video_id}", "format": "json"}
        )
        request = urllib.request.Request(
            f"https://www.youtube.com/oembed?{query}",
            headers={"User-Agent": "A&D-Voice/1"},
        )
        try:
            metadata = _mapping(loads_object(self._get(request, self._timeout).decode()))
        except (OSError, TimeoutError, ValueError, urllib.error.URLError):
            return None, video_id, False
        return _video_candidate_score(metadata, artist, title), video_id, True


class AuddRecognitionProvider:
    """Audio-fingerprint recognition for imported files, with optional YouTube clip lookup."""

    def __init__(
        self,
        api_token: str,
        *,
        youtube_api_key: str | None = None,
        timeout_seconds: float = 12.0,
        post: Post = _multipart_post,
        find_video: FindVideo | None = None,
    ) -> None:
        self._token = api_token
        self._timeout = timeout_seconds
        self._post = post
        self._find_video = find_video or YoutubeVideoFinder(youtube_api_key, timeout_seconds)

    def recognize(self, source: Path) -> RecognizedSong | None:
        try:
            payload = self._post(
                "https://api.audd.io/",
                {"api_token": self._token, "return": "apple_music,spotify"},
                source,
                self._timeout,
            )
        except (OSError, TimeoutError, ValueError, socket.timeout, urllib.error.URLError):
            return None
        result = _mapping(payload).get("result")
        row = _mapping(result)
        title, artist = _text(row.get("title")), _text(row.get("artist"))
        if not title or not artist:
            return None
        return _recognized_song(row, title, artist, self._find_video)


class FallbackSongRecognitionProvider:
    def __init__(self, primary: SongRecognitionProvider, fallback: SongRecognitionProvider) -> None:
        self._primary = primary
        self._fallback = fallback

    def recognize(self, source: Path) -> RecognizedSong | None:
        return self._primary.recognize(source) or self._fallback.recognize(source)


class ItunesCatalogRecognitionProvider:
    """Catalog fallback for named files that fingerprint catalogs do not contain."""

    def __init__(
        self,
        *,
        timeout_seconds: float = 7.0,
        get: Get = _get,
        find_video: FindVideo | None = None,
    ) -> None:
        self._timeout = timeout_seconds
        self._get = get
        self._find_video = find_video or YoutubeVideoFinder(None, timeout_seconds)

    def recognize(self, source: Path) -> RecognizedSong | None:
        identity = split_artist_title(source.stem)
        if identity is None:
            return None
        wanted_artist, wanted_title = identity
        request = _catalog_request(wanted_artist, wanted_title)
        try:
            payload = loads_object(self._get(request, self._timeout).decode("utf-8"))
        except (OSError, TimeoutError, ValueError, urllib.error.URLError):
            return None
        results = payload.get("results") if isinstance(payload, dict) else None
        rows = (
            [item for item in results if isinstance(item, dict)]
            if isinstance(results, list)
            else []
        )
        if not rows:
            return None
        row = max(rows, key=lambda item: _catalog_score(item, wanted_artist, wanted_title))
        if _catalog_score(row, wanted_artist, wanted_title) < 6:
            return None
        return self._recognized_from_row(row)

    def _recognized_from_row(self, row: JsonObject) -> RecognizedSong | None:
        title = _text(row.get("trackName"))
        artist = _text(row.get("artistName"))
        if not title or not artist:
            return None
        artwork = _text(row.get("artworkUrl100"))
        if artwork:
            artwork = artwork.replace("100x100", "1200x1200")
        external = row.get("trackId")
        return RecognizedSong(
            title=title,
            artist=artist,
            album=_text(row.get("collectionName")),
            genre=_text(row.get("primaryGenreName")),
            artwork_url=artwork,
            video_url=self._find_video(artist, title),
            provider="Apple Music Search",
            external_id=str(external) if isinstance(external, (int, str)) else None,
        )


def _catalog_score(row: JsonObject, artist: str, title: str) -> int:
    wanted_artist, wanted_title = _normalized(artist), _normalized(title)
    found_artist = _normalized(_text(row.get("artistName")) or "")
    found_title = _normalized(_text(row.get("trackName")) or "")
    title_score = 4 if found_title == wanted_title else (2 if wanted_title in found_title else 0)
    artist_score = 3 if found_artist == wanted_artist else (
        2 if SequenceMatcher(None, wanted_artist, found_artist).ratio() >= 0.75 else 0
    )
    return title_score + artist_score


def _video_candidate_score(row: JsonObject, artist: str, title: str) -> int | None:
    candidate_title = _text(row.get("title")) or ""
    author = _text(row.get("author_name")) or ""
    searchable = normalize_catalog_identity(f"{candidate_title} {author}")
    wanted_title = normalize_catalog_identity(title)
    wanted_artist = normalize_catalog_identity(artist)
    lowered = f"{candidate_title} {author}".casefold()
    rejected = (" - topic", "lyrics", "lyric video", "karaoke", "fan clip", "fan-made")
    if any(hint in lowered for hint in rejected) or wanted_title not in searchable:
        return None
    candidate_artist = normalize_catalog_identity(author)
    title_artist = searchable.replace(wanted_title, "")
    artist_ratio = max(
        SequenceMatcher(None, wanted_artist, candidate_artist).ratio(),
        SequenceMatcher(None, wanted_artist, title_artist).ratio(),
    )
    artist_present = wanted_artist in searchable or artist_ratio >= 0.72
    if not artist_present:
        return None
    bonus = 40 if "official video" in lowered or "official music video" in lowered else 0
    return 100 + bonus - len(searchable)


def _catalog_request(artist: str, title: str) -> urllib.request.Request:
    query = urllib.parse.urlencode({"term": f"{artist} {title}", "entity": "song", "limit": "10"})
    return urllib.request.Request(
        f"https://itunes.apple.com/search?{query}",
        headers={"User-Agent": "A&D-Voice/1"},
    )


def _normalized(value: str) -> str:
    return normalize_catalog_identity(value)


def _recognized_song(
    row: JsonObject, title: str, artist: str, find_video: FindVideo | None
) -> RecognizedSong:
    apple, spotify = _mapping(row.get("apple_music")), _mapping(row.get("spotify"))
    artwork = _text(_mapping(apple.get("artwork")).get("url"))
    if artwork:
        artwork = artwork.replace("{w}", "1200").replace("{h}", "1200")
    if not artwork:
        images = _mapping(spotify.get("album")).get("images")
        first = images[0] if isinstance(images, list) and images else None
        artwork = _text(_mapping(first).get("url"))
    genres = apple.get("genreNames")
    genre = (
        next((item for item in genres if isinstance(item, str) and item.lower() != "music"), None)
        if isinstance(genres, list)
        else None
    )
    return RecognizedSong(
        title=title,
        artist=artist,
        album=_text(row.get("album")),
        genre=genre,
        artwork_url=artwork,
        video_url=find_video(artist, title) if find_video else None,
        provider="AudD",
        external_id=_text(apple.get("id")) or _text(spotify.get("id")),
    )


def _mapping(value: object) -> JsonObject:
    return value if isinstance(value, dict) else {}


def _text(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None
