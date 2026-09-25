from __future__ import annotations

import os

import uvicorn

from backend.api.app import create_app
from backend.bootstrap.config import BackendConfig
from backend.infrastructure.logging_config import configure_logging
from backend.infrastructure.job_executor import watch_parent_input
from backend.infrastructure.lrclib_provider import LrclibLyricsProvider
from backend.infrastructure.tekst_pesenok_provider import TekstPesenokLyricsProvider


def main() -> None:
    config = BackendConfig.load()
    configure_logging(config.roots.logs, config.log_level)
    managed = os.environ.get("AD_VOICE_MANAGED") == "1"
    announced = False

    async def announce_endpoint() -> None:
        nonlocal announced
        if not announced:
            port = server.servers[0].sockets[0].getsockname()[1]
            print(f"AD_VOICE_BACKEND_READY:{port}", flush=True)
            announced = True

    server = uvicorn.Server(
        uvicorn.Config(
            create_app(
                config,
                lyrics_providers=(LrclibLyricsProvider(), TekstPesenokLyricsProvider()),
            ),
            host=config.host,
            port=config.port,
            log_level=config.log_level.lower(),
            callback_notify=announce_endpoint if managed else None,
        )
    )
    if managed:

        def stop_server() -> None:
            server.should_exit = True

        watch_parent_input(stop_server)
    server.run()


if __name__ == "__main__":
    main()
