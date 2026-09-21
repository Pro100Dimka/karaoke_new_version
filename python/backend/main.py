from __future__ import annotations

import uvicorn

from backend.api.app import create_app
from backend.bootstrap.config import BackendConfig
from backend.infrastructure.logging_config import configure_logging
from backend.infrastructure.lrclib_provider import LrclibLyricsProvider


def main() -> None:
    config = BackendConfig.load()
    configure_logging(config.roots.logs, config.log_level)
    uvicorn.run(
        create_app(config, lyrics_providers=(LrclibLyricsProvider(),)),
        host=config.host,
        port=config.port,
        log_level=config.log_level.lower(),
    )


if __name__ == "__main__":
    main()
