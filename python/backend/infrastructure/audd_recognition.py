from __future__ import annotations

import mimetypes
import socket
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Callable, Mapping

from backend.songs.recognition import RecognizedSong
from backend.serialization import loads_object

JsonObject = Mapping[str, object]
Post = Callable[[str, dict[str, str], Path, float], object]
FindVideo = Callable[[str, str], str | None]


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
    def __init__(self, api_key: str, timeout_seconds: float = 7.0) -> None:
        self._api_key = api_key
        self._timeout = timeout_seconds

    def __call__(self, artist: str, title: str) -> str | None:
        query = urllib.parse.urlencode(
            {
                "part": "snippet",
                "maxResults": "1",
                "q": f"{artist} {title} official music video",
                "type": "video",
                "videoEmbeddable": "true",
                "key": self._api_key,
            }
        )
        request = urllib.request.Request(
            f"https://www.googleapis.com/youtube/v3/search?{query}",
            headers={"User-Agent": "A&D-Voice/1"},
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                payload = loads_object(response.read().decode("utf-8"))
        except (OSError, TimeoutError, ValueError, urllib.error.URLError):
            return None
        if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
            return None
        items = payload["items"]
        first = items[0] if items else None
        identity = first.get("id") if isinstance(first, dict) else None
        video_id = identity.get("videoId") if isinstance(identity, dict) else None
        return f"https://www.youtube.com/watch?v={video_id}" if isinstance(video_id, str) else None


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
        self._find_video = find_video or (
            YoutubeVideoFinder(youtube_api_key, timeout_seconds) if youtube_api_key else None
        )

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
