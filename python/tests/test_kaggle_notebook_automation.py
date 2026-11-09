from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.domain_errors import DependencyError
from backend.infrastructure.kaggle_notebook_automation import KaggleNotebookAutomation
from backend.infrastructure.process_runner import ProcessResult


class FakeRunner:
    def __init__(self, callback):
        self.callback = callback

    def run(self, command, **kwargs):
        return self.callback(list(command), **kwargs)


@pytest.fixture
def offline_notebook_state(monkeypatch):
    monkeypatch.setattr(KaggleNotebookAutomation, "_state", lambda *_: {"status": "MISSING"})


@pytest.mark.parametrize("source_as_text", [False, True])
def test_notebook_inspection_accepts_both_source_encodings(monkeypatch, source_as_text):
    import contextlib
    import io
    import sys
    from datetime import datetime, UTC
    from types import SimpleNamespace

    line = 'os.environ["AD_VOICE_TOKEN"] = "worker-token"\n'
    notebook = {"cells": [{"source": line if source_as_text else [line]}]}
    kernel = SimpleNamespace(
        blob=SimpleNamespace(source=json.dumps(notebook)),
        metadata=SimpleNamespace(last_run_time=datetime.now(UTC)),
    )
    client = SimpleNamespace(
        kernels=SimpleNamespace(kernels_api_client=SimpleNamespace(get_kernel=lambda _: kernel))
    )
    api = SimpleNamespace(
        authenticate=lambda: None,
        kernels_status=lambda _: SimpleNamespace(status=SimpleNamespace(name="RUNNING")),
        build_kaggle_client=lambda: contextlib.nullcontext(client),
    )
    monkeypatch.setitem(
        sys.modules, "kaggle.api.kaggle_api_extended", SimpleNamespace(KaggleApi=lambda: api)
    )

    def run(command, **kwargs):
        monkeypatch.setattr(sys, "argv", ["-c", *command[3:]])
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            exec(command[2], {})
        return ProcessResult(0, output.getvalue().encode(), b"")

    state = KaggleNotebookAutomation(runner=FakeRunner(run))._state(
        "singer/notebook", "worker-token"
    )
    assert state["matching"] is True
    assert state["status"] == "RUNNING"


@pytest.mark.parametrize("status", ["RUNNING", "QUEUED"])
def test_deploy_reuses_matching_live_notebook_instead_of_pushing_again(status, monkeypatch):
    automation = KaggleNotebookAutomation(username_loader=lambda: "singer")
    monkeypatch.setattr(
        automation,
        "_state",
        lambda *_: {"status": status, "age": 60, "matching": True},
        raising=False,
    )
    monkeypatch.setattr(automation, "_run", lambda *_: pytest.fail("Must not push another version"))
    result = automation.deploy("worker-token", "http://rooms:8081", "ad-voice-gpu-123456789abc")
    assert result.url.endswith("singer/ad-voice-gpu-123456789abc")


def test_stalled_notebook_requires_explicit_recovery(monkeypatch):
    automation = KaggleNotebookAutomation(username_loader=lambda: "singer")
    monkeypatch.setattr(
        automation,
        "_state",
        lambda *_: {"status": "QUEUED", "age": 90000, "matching": True},
        raising=False,
    )
    monkeypatch.setattr(automation, "_run", lambda *_: pytest.fail("Must not delete or push"))
    with pytest.raises(DependencyError) as error:
        automation.deploy("worker-token", "http://rooms:8081", "ad-voice-gpu-123456789abc")
    assert error.value.code == "KaggleNotebookStalled"


@pytest.mark.parametrize("next_status", ["QUEUED", "RUNNING"])
def test_recovery_backs_up_and_rechecks_only_the_installation_notebook(
    tmp_path, monkeypatch, next_status
):
    commands = []

    def run(command, **kwargs):
        commands.append(command[4])
        assert "singer/ad-voice-gpu-123456789abc" in command or "push" in command
        if command[4] == "pull":
            folder = Path(command[command.index("-p") + 1])
            (folder / "saved.ipynb").write_text("{}")
            (folder / "kernel-metadata.json").write_text("{}")
        return ProcessResult(0, b"ok", b"")

    automation = KaggleNotebookAutomation(runner=FakeRunner(run), username_loader=lambda: "singer")
    states = iter(
        [
            {"status": "QUEUED", "age": 90000},
            {"status": next_status, "age": 90000},
        ]
    )
    monkeypatch.setattr(automation, "_state", lambda *_: next(states))
    monkeypatch.setattr(automation, "_notebook", lambda *_: {})
    if next_status == "RUNNING":
        with pytest.raises(DependencyError) as error:
            automation.deploy(
                "worker-token",
                "http://rooms",
                "ad-voice-gpu-123456789abc",
                recovery_directory=tmp_path,
            )
        assert error.value.code == "KaggleNotebookBusy"
        assert commands == ["pull"]
    else:
        automation.deploy(
            "worker-token", "http://rooms", "ad-voice-gpu-123456789abc", recovery_directory=tmp_path
        )
        assert commands == ["pull", "delete", "push"]
    assert list(tmp_path.glob("*/saved.ipynb"))


def test_notebook_subprocesses_receive_the_processing_cancellation_event() -> None:
    import threading

    cancel = threading.Event()
    received = []

    def run(command, **kwargs):
        received.append(kwargs.get("cancel"))
        return ProcessResult(0, b"singer", b"")

    automation = KaggleNotebookAutomation(
        account_token="test-token", runner=FakeRunner(run), cancel=cancel
    )
    assert automation.login() == "Kaggle account connected: singer"
    assert received == [cancel]


def test_deploy_preserves_the_requested_slug_for_the_private_gpu_notebook(
    tmp_path: Path,
    offline_notebook_state,
) -> None:
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "ad_voice_p100.ipynb").write_text(
        json.dumps(
            {
                "cells": [
                    {"cell_type": "markdown", "source": ["A&D Voice"]},
                    {
                        "cell_type": "code",
                        "source": [
                            "from kaggle_secrets import UserSecretsClient\n",
                            'token = UserSecretsClient().get_secret("AD_VOICE_TOKEN")\n',
                            'os.environ["AD_VOICE_TOKEN"] = token\n',
                        ],
                    },
                ],
                "metadata": {},
                "nbformat": 4,
                "nbformat_minor": 5,
            }
        ),
        encoding="utf-8",
    )
    captured: dict[str, object] = {}

    def run(command: list[str], **options: object) -> ProcessResult:
        folder = Path(command[command.index("-p") + 1])
        captured["command"] = command
        captured["notebook"] = json.loads(
            (folder / "ad_voice_p100.ipynb").read_text(encoding="utf-8")
        )
        captured["metadata"] = json.loads(
            (folder / "kernel-metadata.json").read_text(encoding="utf-8")
        )
        captured["environment"] = options.get("environment")
        return ProcessResult(0, b"Kernel version 3 successfully pushed", b"")

    result = KaggleNotebookAutomation(
        assets_root=assets,
        account_token="personal-kaggle-token",
        runner=FakeRunner(run),
        username_loader=lambda: "singer",
    ).deploy(
        "private-app-token",
        "http://rooms.example.com:8081",
        "ad-voice-gpu-install-a1b2",
    )

    source = "".join(captured["notebook"]["cells"][1]["source"])
    assert "UserSecretsClient" not in source
    assert 'os.environ["AD_VOICE_TOKEN"] = "private-app-token"' in source
    assert 'os.environ["AD_VOICE_KAGGLE_DISCOVERY_URL"] = "http://rooms.example.com:8081"' in source
    assert captured["metadata"] == {
        "id": "singer/ad-voice-gpu-install-a1b2",
        "title": "ad-voice-gpu-install-a1b2",
        "code_file": "ad_voice_p100.ipynb",
        "language": "python",
        "kernel_type": "notebook",
        "is_private": True,
        "enable_gpu": True,
        "enable_internet": True,
        "dataset_sources": [],
        "competition_sources": [],
        "kernel_sources": [],
        "model_sources": [],
    }
    assert captured["command"][-2:] == ["--accelerator", "NvidiaTeslaT4"]
    assert captured["environment"] == {"KAGGLE_API_TOKEN": "personal-kaggle-token"}
    assert result.url == "https://www.kaggle.com/code/singer/ad-voice-gpu-install-a1b2"


def test_login_uses_the_official_kaggle_oauth_flow(tmp_path: Path) -> None:
    captured: list[list[str]] = []

    def run(command: list[str], **_: object) -> ProcessResult:
        captured.append(command)
        return ProcessResult(0, b"Authenticated", b"")

    def missing_account() -> str:
        raise DependencyError("KaggleAuthenticationRequired", "Connect your Kaggle account first")

    KaggleNotebookAutomation(
        assets_root=tmp_path,
        runner=FakeRunner(run),
        username_loader=missing_account,
    ).login()

    assert captured == [
        [
            KaggleNotebookAutomation.python_executable(),
            "-m",
            "kaggle",
            "auth",
            "login",
        ]
    ]


def test_login_reuses_the_locally_authenticated_kaggle_account(tmp_path: Path) -> None:
    captured: list[list[str]] = []

    def run(command: list[str], **_: object) -> ProcessResult:
        captured.append(command)
        return ProcessResult(0, b"", b"")

    message = KaggleNotebookAutomation(
        assets_root=tmp_path,
        account_token="personal-kaggle-token",
        runner=FakeRunner(run),
        username_loader=lambda: "singer",
    ).login()

    assert message == "Kaggle account connected: singer"
    assert captured == []


def test_login_uses_the_supplied_account_token_without_opening_oauth(
    tmp_path: Path,
) -> None:
    captured: list[tuple[list[str], object]] = []

    def run(command: list[str], **options: object) -> ProcessResult:
        captured.append((command, options.get("environment")))
        return ProcessResult(0, b"singer\n", b"")

    message = KaggleNotebookAutomation(
        assets_root=tmp_path,
        account_token="personal-kaggle-token",
        runner=FakeRunner(run),
    ).login()

    assert message == "Kaggle account connected: singer"
    assert len(captured) == 1
    assert captured[0][0][1] == "-c"
    assert captured[0][1] == {"KAGGLE_API_TOKEN": "personal-kaggle-token"}


def test_deploy_rejects_a_kaggle_cli_error_even_when_the_cli_returns_zero(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, offline_notebook_state
) -> None:
    def run(_command: list[str], **_: object) -> ProcessResult:
        return ProcessResult(
            0,
            b"Kernel push error: Maximum batch GPU session count of 2 reached.",
            b"",
        )

    automation = KaggleNotebookAutomation(
        assets_root=tmp_path,
        runner=FakeRunner(run),
        username_loader=lambda: "singer",
    )
    monkeypatch.setattr(automation, "_notebook", lambda *_args: {})

    with pytest.raises(DependencyError, match="GPU sessions are in use") as error:
        automation.deploy(
            "private-app-token",
            "http://rooms.example.com:8081",
            "ad-voice-gpu-install-a1b2",
        )
    assert error.value.code == "KaggleGpuSessionLimit"
