from __future__ import annotations

from tempfile import TemporaryDirectory
from pathlib import Path

from backend.bootstrap.build import build_container
from backend.bootstrap.config import BackendConfig


def main() -> int:
    with TemporaryDirectory(prefix="ad-voice-bootstrap-") as directory:
        container = build_container(BackendConfig.load(Path(directory)))
        container.shutdown()
    print("Bootstrap smoke passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
