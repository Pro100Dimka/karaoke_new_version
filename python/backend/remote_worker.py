"""Run on the processing PC. Only outbound HTTPS connections to the existing relay are used."""

from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
import os
import re
import shutil
import signal
import sys
import tempfile
import threading
import time
from pathlib import Path
from collections.abc import Mapping
from functools import partial

import httpx
import soundfile as sf
from dotenv import dotenv_values

from backend.ai.catalog import CATALOG
from backend.cpu_info import logical_cpu_count
from backend.domain_errors import DomainError
from backend.infrastructure.instance_lock import BackendInstanceLock
from backend.infrastructure.job_executor import run_in_background, job_failure
from backend.infrastructure.runtime_probe import SystemRuntimeProbe
from backend.infrastructure.processing_transport import (
    ProcessingTransport,
    read_bundle,
    write_bundle,
)
from backend.infrastructure.process_runner import ProcessRunner, ProcessResult
from backend.processing.policies import cpu_threads_with_headroom
from backend.serialization import dumps, loads_object

# The full application container is needed only in the disposable song subprocess.
if __name__ == "__main__" and len(sys.argv) == 4 and sys.argv[1] == "--process-song":
    from backend.processing.worker_song import process_song_task

logger = logging.getLogger(__name__)
_identifier = re.compile(r"^[a-f0-9]{32}$")


def execute(
    payload: Mapping[str, object], incoming: Path, sessions: Path, cancel: threading.Event
) -> tuple[dict[str, object], dict[str, Path]]:
    action = payload.get("action")
    session_id = _session_id(payload)
    directory = incoming / "complete" if action == "process-song" else sessions / session_id
    if action == "process-song":
        return _complete_song(payload, incoming, directory, cancel)
    vocal = directory / "vocals.wav"
    if action in ["separate", "prepare"]:
        directory.mkdir(exist_ok=False)
    elif not vocal.is_file():
        return {"protocolVersion": 1, "sessionExpired": True}, {}
    os.utime(directory, None)
    if action == "prepare":
        _prepare_vocals(incoming, directory)
        if not vocal.is_file():
            raise ValueError("No vocal supplied")
        return {"protocolVersion": 1}, {}
    if action not in ["separate", "transcribe", "align", "pitch"]:
        raise ValueError("Unsupported processing action")
    language = payload.get("language", "Auto")
    if language not in ["Auto", "Ukrainian", "Russian", "English"]:
        raise ValueError("Unsupported processing language")
    arguments = _worker_arguments(action, payload, incoming, directory, language)
    recognition = directory / ("recognition-" + str(language) + ".json")
    input_data = _alignment_input(action, payload, directory, arguments, recognition)
    result = _run_model(action, arguments, cancel, input_data)
    output = loads_object(result.stdout.decode("utf-8"))
    files: dict[str, Path] = {}
    if action == "transcribe" and not payload.get("startSeconds", 0):
        recognition.write_bytes(result.stdout)
    if action == "separate":
        output = {"rhythm": output.get("rhythm", [])}
        files = _separated_files(directory)
    return {"protocolVersion": 1, **output}, files


def _prepare_vocals(incoming: Path, directory: Path) -> None:
    for name in ["vocals.wav", "instrumental.wav"]:
        source = incoming / name
        if source.is_file():
            shutil.move(source, directory / name)


def _session_id(payload: Mapping[str, object]) -> str:
    session_id = payload.get("session")
    if (
        payload.get("protocolVersion") != 1
        or not isinstance(session_id, str)
        or not _identifier.fullmatch(session_id)
    ):
        raise ValueError("Invalid processing protocol or session")
    return session_id


def _complete_song(
    payload: Mapping[str, object], incoming: Path, directory: Path, cancel: threading.Event
) -> tuple[dict[str, object], dict[str, Path]]:
    directory.mkdir(exist_ok=False)
    (incoming / "task.json").write_text(dumps(payload), encoding="utf-8")
    result = ProcessRunner().run(
        [
            sys.executable,
            "-B",
            "-m",
            "backend.remote_worker",
            "--process-song",
            str(incoming),
            str(directory),
        ],
        timeout_seconds=90 * 60,
        cancel=cancel,
    )
    if result.exit_code:
        logger.error(
            "Song processing failed: %s",
            result.stderr.decode("utf-8", errors="replace")[-3000:],
        )
        raise RuntimeError("Song processing failed")
    response = loads_object((directory / "output.json").read_text(encoding="utf-8"))
    completed_files = {
        name: directory / name
        for name in ["instrumental.flac", "vocals.flac", "melody.flac", "lyrics.json"]
        if (directory / name).is_file()
    }
    return response, completed_files


def _worker_arguments(
    action: str, payload: Mapping[str, object], incoming: Path, directory: Path, language: object
) -> list[str]:
    vocal = directory / "vocals.wav"
    return {
        "separate": ["--input", str(incoming / "input.wav"), "--output", str(directory)],
        "transcribe": [
            "--input",
            str(vocal),
            "--language",
            str(language),
            "--start-seconds",
            str(payload.get("startSeconds", 0)),
        ],
        "align": [
            "--input",
            str(vocal),
            "--language",
            str(language),
            "--lyrics",
            str(payload.get("lyrics", "")),
            "--timing-hints",
            dumps(payload.get("timingHints", [])),
        ],
        "pitch": ["--input", str(vocal)],
    }[action]


def _alignment_input(
    action: str,
    payload: Mapping[str, object],
    directory: Path,
    arguments: list[str],
    recognition: Path,
) -> bytes | None:
    backing = directory / "instrumental.wav"
    input_data = None
    if action == "align":
        scope = payload.get("scope", "")
        if not isinstance(scope, str) or (scope and not _identifier.fullmatch(scope)):
            raise ValueError("Invalid alignment scope")
        if scope:
            arguments.extend(
                [
                    "--reuse-directory",
                    str(directory / ("alignment-" + scope)),
                    "--reuse-reserve",
                    str(2 * 1024**3),
                ]
            )
        if backing.is_file():
            arguments.extend(["--instrumental", str(backing)])
        if recognition.is_file():
            arguments.append("--recognition-stdin")
            input_data = recognition.read_bytes()
    return input_data


def _run_model(
    action: str, arguments: list[str], cancel: threading.Event, input_data: bytes | None
) -> ProcessResult:
    result = ProcessRunner().run(
        [sys.executable, "-B", "-m", "backend.ai_worker", action, *arguments],
        timeout_seconds=3600,
        cancel=cancel,
        input_data=input_data,
    )
    if result.exit_code:
        logger.error(
            "Processing %s failed: %s",
            action,
            result.stderr.decode("utf-8", errors="replace")[-2000:],
        )
        raise RuntimeError("Model processing failed")
    return result


def _separated_files(directory: Path) -> dict[str, Path]:
    files: dict[str, Path] = {}
    # Transfer the same lossless 16-bit stems as the existing remote pipeline.
    for name in ["vocals", "instrumental"]:
        samples, rate = sf.read(directory / (name + ".wav"), dtype="int16", always_2d=True)
        target = directory / (name + ".flac")
        sf.write(target, samples, rate, format="FLAC", subtype="PCM_16")
        files[target.name] = target
    return files


def _heartbeat(
    transport: ProcessingTransport,
    route: str,
    headers: Mapping[str, str],
    root: Path,
    job_id: str,
    stop: threading.Event,
    cancel: threading.Event,
    finished: threading.Event,
) -> None:
    while not finished.is_set():
        if stop.is_set() or (root / "stop.request").exists():
            cancel.set()
            return
        try:
            progress_path = root / "temp" / ("progress-" + job_id + ".json")
            try:
                progress = loads_object(progress_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                progress = None
            state = transport.request(
                "POST", route + "/heartbeat", headers=headers, json=progress
            ).json()
            if state["state"] != "running":
                cancel.set()
                return
        except (httpx.HTTPError, DomainError):
            cancel.set()
            return
        finished.wait(5)


def _job_failed(
    transport: ProcessingTransport, route: str, headers: Mapping[str, str], job_id: str
) -> None:
    logger.exception("Processing job %s failed", job_id)
    try:
        transport.request("POST", route + "/failed", headers=headers)
    except (httpx.HTTPError, DomainError):
        pass


def _transfer_job(
    transport: ProcessingTransport,
    route: str,
    headers: Mapping[str, str],
    root: Path,
    job_id: str,
    cancel: threading.Event,
) -> None:
    with tempfile.TemporaryDirectory(prefix="job-", dir=root / "temp") as temporary:
        incoming = Path(temporary)
        request = incoming / "request.zip"
        transport.download(route + "/input", request, headers)
        payload = read_bundle(request, incoming)
        payload["progressPath"] = str(root / "temp" / ("progress-" + job_id + ".json"))
        if shutil.disk_usage(root).free < 4 * 1024**3:
            raise RuntimeError("Processing PC has insufficient free storage")
        output, files = execute(payload, incoming, root / "sessions", cancel)
        if cancel.is_set():
            raise DomainError("JobCancelled", "Processing was cancelled", 409)
        response = incoming / "result.zip"
        write_bundle(response, output, files)
        with response.open("rb") as content:
            transport.request(
                "PUT",
                route + "/result",
                content=content,
                headers={**headers, "Content-Length": str(response.stat().st_size)},
            )


def run_job(
    transport: ProcessingTransport, ticket: Mapping[str, str], root: Path, stop: threading.Event
) -> None:
    job_id = ticket["jobId"]
    if not _identifier.fullmatch(job_id):
        raise ValueError("Invalid processing job id")
    route = "/worker/jobs/" + job_id
    headers = {"X-Job-Key": ticket["jobKey"]}
    cancel, finished = threading.Event(), threading.Event()

    monitor = run_in_background(
        "processing-heartbeat",
        partial(_heartbeat, transport, route, headers, root, job_id, stop, cancel, finished),
    )
    try:
        with job_failure(partial(_job_failed, transport, route, headers, job_id), suppress=True):
            _transfer_job(transport, route, headers, root, job_id, cancel)
    finally:
        finished.set()
        monitor.join(timeout=65)
        (root / "temp" / ("progress-" + job_id + ".json")).unlink(missing_ok=True)


def _configure_worker(root: Path, settings: Mapping[str, str | None]) -> str | None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[
            RotatingFileHandler(
                root / "worker.log", maxBytes=4 * 1024**2, backupCount=1, encoding="utf-8"
            )
        ],
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    models = Path(settings.get("AD_VOICE_MODELS") or root.parent / "AD Voice/backend-data/models")
    if any(not (models / spec.model_id / spec.version / "model.bin").is_file() for spec in CATALOG):
        raise RuntimeError(
            "Required processing models are missing; download them in the application first"
        )
    os.environ.update(
        AD_VOICE_DATA=str(root),
        AD_VOICE_MODELS=str(models),
        AD_VOICE_COMPUTE_DEVICE="cuda",
        TEMP=str(root / "temp"),
        TMP=str(root / "temp"),
        NUMBA_CACHE_DIR=str(root / "cache" / "numba"),
        HF_HOME=str(root / "cache" / "huggingface"),
        TORCH_HOME=str(root / "cache" / "torch"),
        XDG_CACHE_HOME=str(root / "cache"),
        OMP_NUM_THREADS=str(cpu_threads_with_headroom(logical_cpu_count())),
    )
    facts = SystemRuntimeProbe(ProcessRunner()).inspect()
    if not facts.cuda_available:
        raise RuntimeError("CUDA is unavailable on the processing PC")
    return facts.gpu_name


def _clean_sessions(root: Path) -> None:
    cutoff = time.time() - 24 * 3600
    directories = sorted((root / "sessions").iterdir(), key=lambda p: p.stat().st_mtime)
    sizes = {
        directory: sum(p.stat().st_size for p in directory.rglob("*") if p.is_file())
        for directory in directories
        if directory.is_dir()
    }
    total = sum(sizes.values())
    for directory, size in sizes.items():
        if directory.stat().st_mtime < cutoff or total > 6 * 1024**3:
            shutil.rmtree(directory)
            total -= size


def _poll_jobs(transport: ProcessingTransport, root: Path, stop: threading.Event) -> None:
    while not stop.is_set():
        if (root / "stop.request").exists():
            break
        _clean_sessions(root)
        try:
            ticket = transport.request("POST", "/worker/claim").json().get("job")
            if ticket:
                logger.info("Starting processing job %s", ticket["jobId"])
                run_job(transport, ticket, root, stop)
                continue
        except (httpx.HTTPError, DomainError):
            logger.warning("Processing relay unavailable; retrying in 15 seconds")
        stop.wait(15)


def main() -> None:
    project = Path(__file__).resolve().parents[2]
    settings = dotenv_values(project / "local-secrets" / "env" / "processing-worker.env")
    root = Path(
        os.environ.get("AD_VOICE_PROCESSING_WORKER_DATA")
        or settings.get("AD_VOICE_PROCESSING_WORKER_DATA")
        or project / ".dev-data" / "ProcessingWorker"
    )
    if not root.is_absolute() or root.drive.casefold() != project.drive.casefold():
        raise RuntimeError("The processing worker requires an absolute path on the project drive")
    for name in ["temp", "sessions", "cache"]:
        (root / name).mkdir(parents=True, exist_ok=True)
    if sys.argv[1:] == ["--stop"]:
        (root / "stop.request").touch()
        return
    gpu_name = _configure_worker(root, settings)
    lock = BackendInstanceLock(root / "worker.lock")
    lock.acquire()
    (root / "stop.request").unlink(missing_ok=True)
    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    url = settings.get("AD_VOICE_PROCESSING_URL") or "https://130.61.169.61/processing"
    token = settings.get("AD_VOICE_PROCESSING_WORKER_TOKEN") or ""
    if not url.startswith("https://") or len(token) < 32:
        raise RuntimeError("Configure the worker URL and its private access key")
    transport = ProcessingTransport(url, token)
    logger.info("Processing worker ready: %s", gpu_name)
    try:
        _poll_jobs(transport, root, stop)
    finally:
        transport.close()
        lock.release()


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--process-song":
        process_song_task(Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        main()
