from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

from backend.infrastructure.logging_config import JsonFormatter
from backend.infrastructure.process_runner import ProcessRunner
from backend.infrastructure.processing_cache import LocalProcessingCache
from backend.serialization import loads_object
from tests.conftest import write_wav


def test_processing_cache_detects_corruption_and_discards_entry(tmp_path: Path) -> None:
    source = tmp_path / "source.wav"
    write_wav(source, seconds=0.1)
    cache = LocalProcessingCache(tmp_path / "cache")
    cached = cache.put("key", source)
    cached.write_bytes(b"corrupt")

    assert cache.get("key") is None
    assert not cached.parent.exists()
    assert source.is_file()


def test_structured_log_formatter_emits_json_fields() -> None:
    record = logging.LogRecord("backend.test", logging.WARNING, __file__, 1, "problem", (), None)
    record.requestId = "request-1"
    payload = loads_object(JsonFormatter().format(record))

    assert payload["level"] == "WARNING"
    assert payload["logger"] == "backend.test"
    assert payload["message"] == "problem"
    assert payload["requestId"] == "request-1"


def test_importing_backend_main_has_no_filesystem_side_effect(tmp_path: Path) -> None:
    project_root = Path(__file__).resolve().parents[1]
    environment = {"PYTHONPATH": str(project_root)}
    result = ProcessRunner().run(
        [sys.executable, "-c", "import backend.main; print('ok')"],
        timeout_seconds=5,
        cwd=tmp_path,
        environment=environment,
    )

    assert result.exit_code == 0, result.stderr.decode("utf-8", errors="replace")
    assert result.stdout.strip() == b"ok"
    assert list(tmp_path.iterdir()) == []


def test_process_environment_is_explicitly_extended(tmp_path: Path) -> None:
    result = ProcessRunner().run(
        [sys.executable, "-c", "import os; print(os.environ['AD_VOICE_TEST_VALUE'])"],
        timeout_seconds=5,
        cwd=tmp_path,
        environment={"AD_VOICE_TEST_VALUE": "expected"},
    )
    assert result.stdout.strip() == b"expected"
    assert os.getenv("AD_VOICE_TEST_VALUE") is None
