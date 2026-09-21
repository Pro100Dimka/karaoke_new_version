from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

from backend.serialization import dumps

_STANDARD_FIELDS = frozenset(logging.makeLogRecord({}).__dict__)


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        context = {
            key: value
            for key, value in record.__dict__.items()
            if key not in _STANDARD_FIELDS and not key.startswith("_")
        }
        payload.update(context)
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return dumps(payload)


def configure_logging(log_root: Path, level: str) -> None:
    log_root.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(
        log_root / "backend.log",
        maxBytes=5 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    handler.setFormatter(JsonFormatter())
    root_logger = logging.getLogger()
    root_logger.handlers.clear()
    root_logger.setLevel(level)
    root_logger.addHandler(handler)
