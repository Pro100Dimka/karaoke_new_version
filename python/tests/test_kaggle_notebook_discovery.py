from __future__ import annotations

import ast
import base64
import json
from pathlib import Path
import re
import zlib


def test_kaggle_worker_publishes_the_new_share_url_automatically() -> None:
    source = (Path(__file__).parents[2] / "kaggle" / "ad_voice_server.py").read_text(
        encoding="utf-8"
    )

    assert "/kaggle/endpoint" in source
    assert "share_url" in source
    assert "X-AD-Voice-Endpoint-Key" in source
    assert "hashlib.sha256(token.encode" in source


def test_kaggle_notebook_embeds_the_current_worker() -> None:
    root = Path(__file__).parents[2]
    notebook = json.loads((root / "kaggle" / "ad_voice_p100.ipynb").read_text(encoding="utf-8"))
    setup_source = "".join(notebook["cells"][1]["source"])
    assets = ast.literal_eval(re.search(r"assets = (\{.*\})\nfor relative", setup_source, re.S).group(1))
    embedded_worker = zlib.decompress(
        base64.b64decode(assets["kaggle/ad_voice_server.py"])
    )

    assert embedded_worker == (root / "kaggle" / "ad_voice_server.py").read_bytes()


def test_kaggle_worker_stops_after_five_idle_minutes_and_supports_explicit_shutdown() -> None:
    source = (Path(__file__).parents[2] / "kaggle" / "ad_voice_server.py").read_text(
        encoding="utf-8"
    )

    assert "IDLE_SHUTDOWN_SECONDS = 5 * 60" in source
    assert 'api_name="shutdown"' in source
    assert "with _activity.track():" in source
