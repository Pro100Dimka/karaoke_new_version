"""Run yt-dlp with one client and reject player challenges before processing them."""

from __future__ import annotations

import sys
from typing import Any, NoReturn
from urllib.parse import parse_qs, urlsplit

from yt_dlp import YoutubeDL, parse_options
from yt_dlp.extractor.youtube import YoutubeIE
from yt_dlp.utils import DownloadError, ExtractorError


class VisionYoutubeIE(YoutubeIE):
    @classmethod
    def ie_key(cls) -> str:
        return "Youtube"

    def _extract_player_response(
        self, client: str, *args: Any, **kwargs: Any
    ) -> dict[str, Any] | None:
        if client != "visionos":
            raise ExtractorError("Only the VISIONOS client is permitted", expected=True)
        response = super()._extract_player_response(client, *args, **kwargs)
        data = (response or {}).get("streamingData") or {}
        for item in [*data.get("formats", []), *data.get("adaptiveFormats", [])]:
            query = parse_qs(urlsplit(item.get("url") or "").query, keep_blank_values=True)
            if item.get("signatureCipher") or item.get("cipher") or "n" in query:
                raise ExtractorError("Player challenges are not supported", expected=True)
        return response if isinstance(response, dict) else None

    def _load_player(self, *args: Any, **kwargs: Any) -> NoReturn:
        raise ExtractorError("Player JavaScript is disabled", expected=True)

    def _download_player_url(self, *args: Any, **kwargs: Any) -> NoReturn:
        raise ExtractorError("Player JavaScript is disabled", expected=True)


def main() -> int:
    options = parse_options(sys.argv[1:])
    options.ydl_opts.update(
        js_runtimes={},
        remote_components=set(),
        cachedir=False,
        extractor_args={
            "youtube": {
                "player_client": ["visionos"],
                "player_skip": ["js"],
                "skip": ["hls", "dash"],
                "fetch_pot": ["never"],
            }
        },
    )
    with YoutubeDL(options.ydl_opts) as downloader:
        downloader.add_info_extractor(VisionYoutubeIE(downloader))
        return int(downloader.download(options.urls))


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except DownloadError:
        raise SystemExit(1) from None
