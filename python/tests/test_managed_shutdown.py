from __future__ import annotations

import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend import main


def test_managed_backend_announces_the_bound_port_once(monkeypatch, tmp_path, capsys):
    import asyncio

    options = {}

    class Server:
        servers = [
            SimpleNamespace(sockets=[SimpleNamespace(getsockname=lambda: ("127.0.0.1", 51234))])
        ]

        def __init__(self, _config):
            pass

        def run(self):
            callback = options.get("callback_notify")
            if callback:
                asyncio.run(callback())
                asyncio.run(callback())

    config = SimpleNamespace(
        roots=SimpleNamespace(logs=tmp_path), log_level="INFO", host="127.0.0.1", port=0
    )
    monkeypatch.setattr(main.BackendConfig, "load", lambda: config)
    monkeypatch.setattr(main, "configure_logging", lambda *_: None)
    monkeypatch.setattr(main, "create_app", lambda *_args, **_kwargs: object())
    monkeypatch.setattr(main.uvicorn, "Config", lambda *_args, **kwargs: options.update(kwargs))
    monkeypatch.setattr(main.uvicorn, "Server", Server)
    monkeypatch.setattr(main, "watch_parent_input", lambda *_: None)
    monkeypatch.setenv("AD_VOICE_MANAGED", "1")
    main.main()
    assert capsys.readouterr().out == "AD_VOICE_BACKEND_READY:51234\n"


@pytest.mark.parametrize("managed", [False, True])
def test_managed_backend_stops_on_parent_stdin_eof(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, managed: bool
) -> None:
    observed: list[bool] = []

    class Server:
        should_exit = False

        def __init__(self, _config: object) -> None:
            pass

        def run(self) -> None:
            if managed:
                for _ in range(100):
                    if self.should_exit:
                        break
                    threading.Event().wait(0.002)
            observed.append(self.should_exit)

    config = SimpleNamespace(
        roots=SimpleNamespace(logs=tmp_path), log_level="INFO", host="127.0.0.1", port=0
    )
    monkeypatch.setattr(main.BackendConfig, "load", lambda: config)
    monkeypatch.setattr(main, "configure_logging", lambda *_: None)
    monkeypatch.setattr(main, "create_app", lambda *_args, **_kwargs: object())
    monkeypatch.setattr(main.uvicorn, "Config", lambda *_args, **_kwargs: object())
    monkeypatch.setattr(main.uvicorn, "Server", Server)
    monkeypatch.setattr(main.uvicorn, "run", lambda *_args, **_kwargs: Server(None).run())
    monkeypatch.setattr("backend.infrastructure.job_executor.os.read", lambda *_: b"")
    if managed:
        monkeypatch.setenv("AD_VOICE_MANAGED", "1")
    else:
        monkeypatch.delenv("AD_VOICE_MANAGED", raising=False)

    main.main()

    assert observed == [managed]
