from __future__ import annotations

import ast
import base64
import json
from pathlib import Path
import re
import zlib

import pytest


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
    assets = ast.literal_eval(
        re.search(r"assets = (\{.*\})\nfor relative", setup_source, re.S).group(1)
    )
    for relative in (
        "kaggle/ad_voice_server.py",
        "python/backend/ai_worker/pitch.py",
        "python/backend/ai_worker/ctc.py",
        "python/backend/ai_worker/speech.py",
        "python/backend/ai_worker/timing.py",
        "python/backend/lyrics/discovery.py",
        "python/backend/text_normalization.py",
    ):
        assert relative in assets, f"The notebook omits the current worker asset: {relative}"
        assert zlib.decompress(base64.b64decode(assets[relative])) == (root / relative).read_bytes()


def test_kaggle_worker_stops_after_five_idle_minutes_and_supports_explicit_shutdown() -> None:
    source = (Path(__file__).parents[2] / "kaggle" / "ad_voice_server.py").read_text(
        encoding="utf-8"
    )

    assert "IDLE_SHUTDOWN_SECONDS = 5 * 60" in source
    assert 'api_name="shutdown"' in source
    assert "with _activity.track():" in source


def test_server_registers_existing_vocal_in_a_ttl_managed_session_without_separation(tmp_path):
    import os
    import shutil
    import threading
    import time
    import uuid
    from types import SimpleNamespace

    server = Path(__file__).parents[2] / "kaggle" / "ad_voice_server.py"
    source = server.read_text(encoding="utf-8")
    functions = {node.name: node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef)}
    assert "prepare_vocal" in functions, "Existing projects need a vocal-upload session endpoint"
    assert 'api_name="prepare_vocal"' in source
    sessions = tmp_path / "sessions"
    stale = sessions / ("a" * 32)
    stale.mkdir(parents=True)
    os.utime(stale, (0, 0))
    namespace = {
        "Path": Path, "SESSIONS": sessions, "TTL_SECONDS": 6 * 60 * 60,
        "os": os, "shutil": shutil, "time": time, "uuid": uuid, "json": json,
        "_lock": threading.Lock(), "_pitch_jobs": {},
        "gr": SimpleNamespace(Error=RuntimeError), "_track_activity": lambda function: function,
    }
    selected = [functions[name] for name in ("_cleanup", "_new_session", "_session", "prepare_vocal")]
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(server), "exec"), namespace)
    vocal = tmp_path / "source-vocal.wav"
    vocal.write_bytes(b"preserved vocal bytes")
    backing = tmp_path / "source-backing.wav"
    backing.write_bytes(b"preserved backing bytes")

    session_id = namespace["prepare_vocal"](str(vocal), str(backing))
    directory = namespace["_session"](session_id)

    assert len(session_id) == 32 and all(character in "0123456789abcdef" for character in session_id)
    assert (directory / "separation" / "vocals.wav").read_bytes() == vocal.read_bytes()
    assert (directory / "separation" / "instrumental.wav").read_bytes() == backing.read_bytes()
    assert not stale.exists()
    os.utime(directory, (0, 0))
    namespace["_cleanup"]()
    import pytest

    with pytest.raises(RuntimeError) as error:
        namespace["_session"](session_id)
    assert json.loads(str(error.value))["code"] == "KaggleSessionExpired"


@pytest.mark.parametrize("has_backing", [False, True])
def test_server_alignment_receives_the_uploaded_backing_when_available(tmp_path, has_backing):
    from unittest.mock import Mock

    source = (Path(__file__).parents[2] / "kaggle/ad_voice_server.py").read_text(encoding="utf-8")
    function = next(node for node in ast.parse(source).body
                    if isinstance(node, ast.FunctionDef) and node.name == "align_song")
    separation = tmp_path / "separation"
    separation.mkdir()
    backing = separation / "instrumental.wav"
    if has_backing:
        backing.write_bytes(b"backing audio")
    align = Mock(return_value={"words": []})
    namespace = {"Path": Path, "json": json, "align": align,
                 "_session": lambda _session: tmp_path, "_track_activity": lambda function: function}
    exec(compile(ast.Module(body=[function], type_ignores=[]), "server-align", "exec"), namespace)
    namespace["align_song"]("session", "hello", "English", "[]")
    align.assert_called_once_with(separation / "vocals.wav", "hello", "English", [],
                                  instrumental=backing if has_backing else None)


def test_server_health_identifies_its_process_generation():
    import uuid
    from types import SimpleNamespace

    source = (Path(__file__).parents[2] / "kaggle/ad_voice_server.py").read_text(encoding="utf-8")
    nodes = [node for node in ast.parse(source).body if (
        isinstance(node, ast.FunctionDef) and node.name == "health"
    ) or (
        isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id in {"SESSION_GENERATION", "PROTOCOL_VERSION"}
            for target in node.targets
        )
    )]
    namespace = {"uuid": uuid, "torch": SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False))}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "server-health", "exec"), namespace)
    first = namespace["health"]()["sessionGeneration"]
    assert len(first) == 32
    assert namespace["health"]()["protocolVersion"] == 5
    assert namespace["health"]()["sessionGeneration"] == first
