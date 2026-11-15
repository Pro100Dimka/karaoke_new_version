from __future__ import annotations

import re
import sys

from backend.domain_errors import DomainError
from backend.infrastructure.process_runner import ProcessRunner
from backend.serialization import JsonValue, loads_object


class YoutubeRadio:
    """Resolve one playlist entry for streaming; never download playlist media."""

    def __init__(self, processes: ProcessRunner | None = None) -> None:
        self._processes = processes or ProcessRunner()

    def resolve(self, playlist_id: str, index: int) -> dict[str, str | int]:
        if not re.fullmatch(r"[A-Za-z0-9_-]{10,100}", playlist_id) or not 1 <= index <= 100_000:
            raise DomainError("YoutubePlaylistInvalid", "Invalid YouTube playlist", 400)
        playlist, entry, index = self._playlist_item(playlist_id, index)
        video_id = str(entry.get("id", ""))
        if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
            raise DomainError("YoutubePlaylistUnavailable", "Playlist track is unavailable", 422)
        video = self._extract(
            f"https://www.youtube.com/watch?v={video_id}",
            ["--no-playlist", "-f", "bestaudio[ext=m4a]/bestaudio"],
        )
        url = str(video.get("url") or "")
        if not url.startswith(("https://", "http://")):
            raise DomainError("YoutubePlaylistUnavailable", "Audio stream is unavailable", 422)
        count = playlist.get("playlist_count")
        return {
            "playlistId": playlist_id,
            "playlistTitle": str(playlist.get("title") or "YouTube"),
            "index": index,
            "count": count if isinstance(count, int) and count > 0 else 0,
            "id": video_id,
            "title": str(video.get("title") or entry.get("title") or "YouTube"),
            "artist": str(video.get("artist") or video.get("uploader") or ""),
            "url": url,
        }

    def _playlist_item(
        self, playlist_id: str, index: int
    ) -> tuple[dict[str, JsonValue], dict[str, JsonValue], int]:
        for position in [index] if index == 1 else [index, 1]:
            playlist = self._extract(
                f"https://www.youtube.com/playlist?list={playlist_id}",
                ["--flat-playlist", "--playlist-items", str(position)],
            )
            entries = playlist.get("entries")
            if isinstance(entries, list) and entries and isinstance(entries[0], dict):
                return playlist, entries[0], position
        raise DomainError("YoutubePlaylistUnavailable", "Playlist has no available tracks", 422)

    def _extract(self, url: str, options: list[str]) -> dict[str, JsonValue]:
        result = self._processes.run(
            [
                sys.executable,
                "-m",
                "yt_dlp",
                "--ignore-config",
                "--no-cache-dir",
                "--skip-download",
                "--dump-single-json",
                "--no-warnings",
                "--socket-timeout",
                "10",
                "--retries",
                "1",
                "--js-runtimes",
                "node",
                *options,
                url,
            ],
            timeout_seconds=12,
        )
        if result.exit_code != 0:
            raise DomainError(
                "YoutubePlaylistUnavailable", "YouTube could not open this playlist or track", 422
            )
        try:
            return loads_object(result.stdout.decode("utf-8"))
        except (ValueError, UnicodeError) as error:
            raise DomainError(
                "YoutubePlaylistUnavailable", "Invalid YouTube response", 502
            ) from error
