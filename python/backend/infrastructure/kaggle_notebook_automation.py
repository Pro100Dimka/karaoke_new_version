from __future__ import annotations

import os
import re
import secrets
import sys
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from backend.domain_errors import DependencyError
from backend.infrastructure.process_runner import ProcessResult, ProcessRunner
from backend.serialization import dumps, loads_object

UsernameLoader = Callable[[], str]


def installation_notebook_slug(app_root: Path) -> str:
    identity_file = app_root / "kaggle-installation-id"
    if identity_file.is_file():
        identity = identity_file.read_text(encoding="utf-8").strip().lower()
        if re.fullmatch(r"[0-9a-f]{12}", identity):
            return f"ad-voice-gpu-{identity}"
    identity = secrets.token_hex(6)
    identity_file.parent.mkdir(parents=True, exist_ok=True)
    identity_file.write_text(identity, encoding="utf-8")
    return f"ad-voice-gpu-{identity}"


@dataclass(frozen=True, slots=True)
class KaggleDeployment:
    url: str
    message: str


class KaggleNotebookAutomation:
    """Authenticates with Kaggle and publishes the private A&D Voice GPU notebook."""

    def __init__(
        self,
        *,
        account_token: str | None = None,
        assets_root: Path | None = None,
        runner: ProcessRunner | None = None,
        username_loader: UsernameLoader | None = None,
    ) -> None:
        configured = os.getenv("AD_VOICE_KAGGLE_ASSETS", "").strip()
        self._assets_root = assets_root or (
            Path(configured) if configured else Path(__file__).parents[3] / "kaggle"
        )
        self._account_token = (account_token or "").strip()
        self._runner = runner or ProcessRunner()
        self._username_loader = username_loader or self._authenticated_username

    @staticmethod
    def python_executable() -> str:
        return sys.executable

    def login(self) -> str:
        try:
            return f"Kaggle account connected: {self._valid_username()}"
        except DependencyError as error:
            if error.code != "KaggleAuthenticationRequired":
                raise
        result = self._run(
            [self.python_executable(), "-m", "kaggle", "auth", "login"], 600
        )
        return self._output(result) or "Kaggle account connected"

    def deploy(
        self,
        token: str,
        discovery_url: str,
        notebook_slug: str,
    ) -> KaggleDeployment:
        username = self._valid_username()
        if not re.fullmatch(r"[a-z0-9-]{1,64}", notebook_slug):
            raise DependencyError("KaggleNotebookInvalid", "Kaggle notebook name is invalid")
        notebook = self._notebook(token, discovery_url)
        with tempfile.TemporaryDirectory(prefix="ad-voice-kaggle-") as folder:
            target = Path(folder)
            self._write_deployment(target, username, notebook_slug, notebook)
            result = self._run(
                [
                    self.python_executable(), "-m", "kaggle", "kernels", "push",
                    "-p", str(target), "--accelerator", "NvidiaTeslaT4",
                ],
                600,
            )
        return KaggleDeployment(
            url=f"https://www.kaggle.com/code/{username}/{notebook_slug}",
            message=self._output(result) or "Kaggle GPU notebook started",
        )

    def _valid_username(self) -> str:
        username = self._username_loader().strip()
        if not re.fullmatch(r"[A-Za-z0-9_-]+", username):
            raise DependencyError("KaggleAccountInvalid", "Kaggle account name is invalid")
        return username

    def _notebook(self, token: str, discovery_url: str) -> dict[str, object]:
        source = self._assets_root / "ad_voice_p100.ipynb"
        if not source.is_file():
            raise DependencyError("KaggleNotebookMissing", "Kaggle notebook template is missing")
        notebook = loads_object(source.read_text(encoding="utf-8"))
        cells = notebook.get("cells")
        if not isinstance(cells, list) or len(cells) < 2 or not isinstance(cells[1], dict):
            raise DependencyError("KaggleNotebookInvalid", "Kaggle notebook template is invalid")
        setup = "".join(str(line) for line in cells[1].get("source", []))
        setup = re.sub(
            r"^from kaggle_secrets import UserSecretsClient\s*$", "", setup,
            flags=re.MULTILINE,
        )
        setup = re.sub(
            r'^token = UserSecretsClient\(\)\.get_secret\("AD_VOICE_TOKEN"\)\s*$',
            f"token = {dumps(token)}", setup, flags=re.MULTILINE,
        )
        setup = setup.replace(
            'os.environ["AD_VOICE_TOKEN"] = token', self._environment(token, discovery_url)
        )
        cells[1]["source"] = setup.splitlines(keepends=True)
        return notebook

    @staticmethod
    def _environment(token: str, discovery_url: str) -> str:
        return "\n".join(
            (
                f'os.environ["AD_VOICE_TOKEN"] = {dumps(token)}',
                'os.environ["AD_VOICE_KAGGLE_DISCOVERY_URL"] = '
                f"{dumps(discovery_url.rstrip('/'))}",
            )
        )

    @staticmethod
    def _write_deployment(
        target: Path,
        username: str,
        notebook_slug: str,
        notebook: object,
    ) -> None:
        (target / "ad_voice_p100.ipynb").write_text(
            dumps(notebook, pretty=True), encoding="utf-8"
        )
        metadata = {
            "id": f"{username}/{notebook_slug}", "title": notebook_slug,
            "code_file": "ad_voice_p100.ipynb", "language": "python",
            "kernel_type": "notebook", "is_private": True, "enable_gpu": True,
            "enable_internet": True, "dataset_sources": [], "competition_sources": [],
            "kernel_sources": [], "model_sources": [],
        }
        (target / "kernel-metadata.json").write_text(
            dumps(metadata, pretty=True), encoding="utf-8"
        )

    def _authenticated_username(self) -> str:
        if self._account_token:
            result = self._run(
                [
                    self.python_executable(),
                    "-c",
                    (
                        "from kaggle.api.kaggle_api_extended import KaggleApi; "
                        "api=KaggleApi(); api.authenticate(); "
                        "print(api.get_config_value(api.CONFIG_NAME_USER) or '')"
                    ),
                ],
                60,
            )
            return self._output(result).splitlines()[-1].strip()
        try:
            from kaggle.api.kaggle_api_extended import KaggleApi

            api = KaggleApi()
            api.authenticate()
            return str(api.get_config_value(api.CONFIG_NAME_USER) or "")
        except (ImportError, SystemExit) as error:
            raise DependencyError(
                "KaggleAuthenticationRequired", "Connect your Kaggle account first"
            ) from error

    def _run(self, command: list[str], timeout: int) -> ProcessResult:
        environment = (
            {"KAGGLE_API_TOKEN": self._account_token}
            if self._account_token
            else None
        )
        result = self._runner.run(
            command,
            timeout_seconds=timeout,
            environment=environment,
        )
        stdout = self._output(result)
        stderr = self._output(result, stderr=True)
        if result.exit_code or re.search(r"(?im)^Kernel push error:", stdout + "\n" + stderr):
            message = stderr or stdout or "Kaggle command failed"
            raise DependencyError("KaggleAutomationFailed", message)
        return result

    @staticmethod
    def _output(result: ProcessResult, *, stderr: bool = False) -> str:
        value = result.stderr if stderr else result.stdout
        return value.decode("utf-8", errors="replace").strip()
