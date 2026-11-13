from __future__ import annotations

import os
import re
import secrets
import hashlib
import time
import sys
import threading
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from functools import cached_property
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
        cancel: threading.Event | None = None,
    ) -> None:
        configured = os.getenv("AD_VOICE_KAGGLE_ASSETS", "").strip()
        self._assets_root = assets_root or (
            Path(configured) if configured else Path(__file__).parents[3] / "kaggle"
        )
        self._account_token = (account_token or "").strip()
        self._runner = runner or ProcessRunner()
        self._username_loader = username_loader or self._authenticated_username
        self._cancel = cancel

    @staticmethod
    def python_executable() -> str:
        return sys.executable

    def login(self) -> str:
        try:
            return f"Kaggle account connected: {self._valid_username()}"
        except DependencyError as error:
            if error.code != "KaggleAuthenticationRequired":
                raise
        result = self._run([self.python_executable(), "-m", "kaggle", "auth", "login"], 600)
        return self._output(result) or "Kaggle account connected"

    def deploy(
        self,
        token: str,
        discovery_url: str,
        notebook_slug: str,
        *,
        recovery_directory: Path | None = None,
    ) -> KaggleDeployment:
        username = self._valid_username()
        if not re.fullmatch(r"[a-z0-9-]{1,64}", notebook_slug):
            raise DependencyError("KaggleNotebookInvalid", "Kaggle notebook name is invalid")
        reference = f"{username}/{notebook_slug}"
        if self._reuse_or_restore(reference, token, recovery_directory):
            return KaggleDeployment(
                f"https://www.kaggle.com/code/{reference}",
                "Kaggle notebook is already starting or running",
            )
        notebook = self._notebook(token, discovery_url)
        with tempfile.TemporaryDirectory(prefix="ad-voice-kaggle-") as folder:
            target = Path(folder)
            self._write_deployment(target, username, notebook_slug, notebook)
            result = self._run(
                [
                    self.python_executable(),
                    "-m",
                    "kaggle",
                    "kernels",
                    "push",
                    "-p",
                    str(target),
                    "--accelerator",
                    "NvidiaTeslaT4",
                ],
                600,
            )
        return KaggleDeployment(
            url=f"https://www.kaggle.com/code/{reference}",
            message=self._output(result) or "Kaggle GPU notebook started",
        )

    def _reuse_or_restore(
        self, reference: str, token: str, recovery_directory: Path | None
    ) -> bool:
        state = self._state(reference, token)
        stalled = state.get("status") == "QUEUED" and float(str(state.get("age", 0))) >= 900
        if stalled:
            if recovery_directory is None:
                raise DependencyError(
                    "KaggleNotebookStalled", "The application notebook is stuck in the Kaggle queue"
                )
            self._restore_queued(reference, token, recovery_directory)
        elif state.get("status") in {"RUNNING", "QUEUED", "CANCEL_REQUESTED"}:
            if not state.get("matching") or state.get("status") == "CANCEL_REQUESTED":
                raise DependencyError(
                    "KaggleNotebookBusy", "A different notebook version is still active"
                )
            return True
        return False

    def _restore_queued(self, reference: str, token: str, recovery_directory: Path) -> None:
        if not re.fullmatch(r"ad-voice-gpu-[0-9a-f]{12}", reference.split("/")[-1]):
            raise DependencyError(
                "KaggleNotebookInvalid", "Only the installation notebook can be restored"
            )
        backup = recovery_directory / str(time.time_ns())
        backup.mkdir(parents=True, exist_ok=False)
        self._run(
            [sys.executable, "-m", "kaggle", "kernels", "pull", reference, "-p", str(backup), "-m"],
            120,
        )
        if not list(backup.glob("*.ipynb")) or not (backup / "kernel-metadata.json").is_file():
            raise DependencyError("KaggleAutomationFailed", "Notebook backup is incomplete")
        state = self._state(reference, token)
        if state.get("status") != "QUEUED" or float(str(state.get("age", 0))) < 900:
            raise DependencyError(
                "KaggleNotebookBusy", "Notebook state changed; it was not removed"
            )
        self._run([sys.executable, "-m", "kaggle", "kernels", "delete", reference, "-y"], 120)

    def _state(self, reference: str, token: str) -> dict[str, object]:
        signature = hashlib.sha256(
            f'os.environ["AD_VOICE_TOKEN"] = {dumps(token)}'.encode()
        ).hexdigest()
        result = self._run(
            [
                sys.executable,
                "-c",
                """
import hashlib, json, sys
from datetime import datetime, timezone
from kaggle.api.kaggle_api_extended import KaggleApi
from kagglesdk.kernels.types.kernels_api_service import ApiGetKernelRequest
from requests.exceptions import HTTPError
api = KaggleApi()
api.authenticate()
try:
    status = api.kernels_status(sys.argv[1]).status.name
    with api.build_kaggle_client() as client:
        request = ApiGetKernelRequest()
        request.user_name, request.kernel_slug = sys.argv[1].split('/')
        kernel = client.kernels.kernels_api_client.get_kernel(request)
    notebook = json.loads(kernel.blob.source)
    matching = any(hashlib.sha256(line.strip().encode()).hexdigest() == sys.argv[2]
                   for cell in notebook.get('cells', []) for line in ''.join(cell.get('source', [])).splitlines())
    started = kernel.metadata.last_run_time
    age = (datetime.now(timezone.utc) - started.replace(tzinfo=timezone.utc)).total_seconds() if started else 0
    print(json.dumps({'status': status, 'age': age, 'matching': matching}))
except HTTPError as error:
    if error.response.status_code != 404:
        raise
    print(json.dumps({'status': 'MISSING'}))
""",
                reference,
                signature,
            ],
            60,
        )
        return loads_object(self._output(result).splitlines()[-1])

    def _valid_username(self) -> str:
        username = self._username_loader().strip()
        if not re.fullmatch(r"[A-Za-z0-9_-]+", username):
            raise DependencyError("KaggleAccountInvalid", "Kaggle account name is invalid")
        return username

    @cached_property
    def revision(self) -> str:
        metadata = self._template().get("metadata")
        revision = metadata.get("ad_voice_revision") if isinstance(metadata, dict) else None
        if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{64}", revision):
            raise DependencyError("KaggleNotebookInvalid", "Kaggle worker revision is missing")
        return revision

    def _template(self) -> dict[str, object]:
        source = self._assets_root / "ad_voice_p100.ipynb"
        if not source.is_file():
            raise DependencyError("KaggleNotebookMissing", "Kaggle notebook template is missing")
        return loads_object(source.read_text(encoding="utf-8"))

    def _notebook(self, token: str, discovery_url: str) -> dict[str, object]:
        notebook = self._template()
        cells = notebook.get("cells")
        if not isinstance(cells, list) or len(cells) < 2 or not isinstance(cells[1], dict):
            raise DependencyError("KaggleNotebookInvalid", "Kaggle notebook template is invalid")
        setup = "".join(str(line) for line in cells[1].get("source", []))
        setup = re.sub(
            r"^from kaggle_secrets import UserSecretsClient\s*$",
            "",
            setup,
            flags=re.MULTILINE,
        )
        setup = re.sub(
            r'^token = UserSecretsClient\(\)\.get_secret\("AD_VOICE_TOKEN"\)\s*$',
            f"token = {dumps(token)}",
            setup,
            flags=re.MULTILINE,
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
                f'os.environ["AD_VOICE_KAGGLE_DISCOVERY_URL"] = {dumps(discovery_url.rstrip("/"))}',
            )
        )

    @staticmethod
    def _write_deployment(
        target: Path,
        username: str,
        notebook_slug: str,
        notebook: object,
    ) -> None:
        (target / "ad_voice_p100.ipynb").write_text(dumps(notebook, pretty=True), encoding="utf-8")
        metadata = {
            "id": f"{username}/{notebook_slug}",
            "title": notebook_slug,
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
        (target / "kernel-metadata.json").write_text(dumps(metadata, pretty=True), encoding="utf-8")

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
        environment = {"KAGGLE_API_TOKEN": self._account_token} if self._account_token else None
        result = self._runner.run(
            command,
            timeout_seconds=timeout,
            environment=environment,
            cancel=self._cancel,
        )
        stdout = self._output(result)
        stderr = self._output(result, stderr=True)
        if re.search(r"Maximum batch GPU session count of \d+ reached", stdout + "\n" + stderr):
            raise DependencyError(
                "KaggleGpuSessionLimit",
                "Kaggle GPU sessions are in use. Stop an unused notebook in Kaggle and try again.",
            )
        if result.exit_code or re.search(r"(?im)^Kernel push error:", stdout + "\n" + stderr):
            message = stderr or stdout or "Kaggle command failed"
            raise DependencyError("KaggleAutomationFailed", message)
        return result

    @staticmethod
    def _output(result: ProcessResult, *, stderr: bool = False) -> str:
        value = result.stderr if stderr else result.stdout
        return value.decode("utf-8", errors="replace").strip()
