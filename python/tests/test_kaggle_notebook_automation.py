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


def test_deploy_preserves_the_requested_slug_for_the_private_gpu_notebook(
    tmp_path: Path,
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
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
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

    with pytest.raises(DependencyError, match="Maximum batch GPU session count"):
        automation.deploy(
            "private-app-token",
            "http://rooms.example.com:8081",
            "ad-voice-gpu-install-a1b2",
        )
