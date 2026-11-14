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

import httpx
import soundfile as sf
from dotenv import dotenv_values

from backend.ai.catalog import CATALOG
from backend.cpu_info import logical_cpu_count
from backend.domain_errors import DomainError
from backend.infrastructure.instance_lock import BackendInstanceLock
from backend.infrastructure.processing_transport import (
    ProcessingTransport,
    read_bundle,
    write_bundle,
)
from backend.infrastructure.process_runner import ProcessRunner
from backend.processing.policies import cpu_threads_with_headroom
from backend.serialization import dumps, loads_object

logger = logging.getLogger(__name__)
_identifier = re.compile(r"^[a-f0-9]{32}$")


def execute(
    payload: Mapping[str, object], incoming: Path, sessions: Path, cancel: threading.Event
) -> tuple[dict[str, object], dict[str, Path]]:
    action = payload.get("action")
    session_id = payload.get("session")
    if (
        payload.get("protocolVersion") != 1
        or not isinstance(session_id, str)
        or not _identifier.fullmatch(session_id)
    ):
        raise ValueError("Invalid processing protocol or session")
    directory = incoming / "complete" if action == "process-song" else sessions / session_id
    if action == "process-song":
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
    vocal, backing = directory / "vocals.wav", directory / "instrumental.wav"
    if action in ["separate", "prepare"]:
        directory.mkdir(exist_ok=False)
    elif not vocal.is_file():
        return {"protocolVersion": 1, "sessionExpired": True}, {}
    os.utime(directory, None)
    if action == "prepare":
        for name in ["vocals.wav", "instrumental.wav"]:
            source = incoming / name
            if source.is_file():
                shutil.move(source, directory / name)
        if not vocal.is_file():
            raise ValueError("No vocal supplied")
        return {"protocolVersion": 1}, {}
    if action not in ["separate", "transcribe", "align", "pitch"]:
        raise ValueError("Unsupported processing action")
    language = payload.get("language", "Auto")
    if language not in ["Auto", "Ukrainian", "Russian", "English"]:
        raise ValueError("Unsupported processing language")
    arguments = {
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
    recognition = directory / ("recognition-" + str(language) + ".json")
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
    output = loads_object(result.stdout.decode("utf-8"))
    files: dict[str, Path] = {}
    if action == "transcribe" and not payload.get("startSeconds", 0):
        recognition.write_bytes(result.stdout)
    if action == "separate":
        # Transfer the same lossless 16-bit stems as the existing remote pipeline.
        output = {"rhythm": output.get("rhythm", [])}
        for name in ["vocals", "instrumental"]:
            samples, rate = sf.read(directory / (name + ".wav"), dtype="int16", always_2d=True)
            target = directory / (name + ".flac")
            sf.write(target, samples, rate, format="FLAC", subtype="PCM_16")
            files[target.name] = target
    return {"protocolVersion": 1, **output}, files


def run_job(
    transport: ProcessingTransport, ticket: Mapping[str, str], root: Path, stop: threading.Event
) -> None:
    job_id = ticket["jobId"]
    if not _identifier.fullmatch(job_id):
        raise ValueError("Invalid processing job id")
    route = "/worker/jobs/" + job_id
    headers = {"X-Job-Key": ticket["jobKey"]}
    cancel, finished = threading.Event(), threading.Event()

    def heartbeat() -> None:
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

    monitor = threading.Thread(target=heartbeat, daemon=True)
    monitor.start()
    try:
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
                return
            response = incoming / "result.zip"
            write_bundle(response, output, files)
            with response.open("rb") as content:
                transport.request(
                    "PUT",
                    route + "/result",
                    content=content,
                    headers={**headers, "Content-Length": str(response.stat().st_size)},
                )
    except Exception:
        logger.exception("Processing job %s failed", job_id)
        try:
            transport.request("POST", route + "/failed", headers=headers)
        except (httpx.HTTPError, DomainError):
            pass
    finally:
        finished.set()
        monitor.join(timeout=65)
        (root / "temp" / ("progress-" + job_id + ".json")).unlink(missing_ok=True)


def process_song_task(incoming: Path, directory: Path) -> None:
    """Use the same complete local processing pipeline in an isolated disposable library."""
    from dataclasses import replace
    from backend.api.policy import ApiPolicy
    from backend.bootstrap.build import build_container
    from backend.bootstrap.config import BackendConfig
    from backend.infrastructure.atomic_files import atomic_write_text
    from backend.infrastructure.hashing import sha256_file
    from backend.infrastructure.local_projects import LocalProjectStorage
    from backend.infrastructure.lrclib_provider import LrclibLyricsProvider
    from backend.infrastructure.pisni_provider import PisniLyricsProvider
    from backend.infrastructure.tekst_pesenok_provider import TekstPesenokLyricsProvider
    from backend.lyrics.codec import decode_document
    from backend.packages.policy import PackagePolicy
    from backend.processing.domain import JobState, ProcessingMode
    from backend.processing.policies import ResourceBudget
    from backend.projects.domain import ArtifactCategory, ProjectArtifact, ProjectRevision
    from backend.projects.fingerprint import manifest_fingerprint
    from backend.projects.manifest_codec import encode_manifest
    from backend.songs.domain import Language
    from backend.songs.import_song import ImportSongRequest
    from backend.songs.recognition import RecognizedSong
    from backend.storage.domain import StorageRoots
    from datetime import datetime, timezone
    import uuid

    class SourceRecognition:
        def recognize(self, source: Path) -> RecognizedSong | None:
            return None

    payload = loads_object((incoming / "task.json").read_text(encoding="utf-8"))
    source_name, metadata = payload["source"], payload["song"]
    if (
        not isinstance(source_name, str)
        or Path(source_name).name != source_name
        or not source_name.startswith("source.")
    ):
        raise ValueError("Invalid song source")
    if not isinstance(metadata, dict):
        raise ValueError("Invalid song metadata")
    roots = replace(
        StorageRoots.under(directory / "runtime"), models=Path(os.environ["AD_VOICE_MODELS"])
    )
    config = BackendConfig(
        roots, ResourceBudget(max_background_jobs=1), PackagePolicy(), ApiPolicy()
    )
    app = build_container(
        config,
        lyrics_providers=(
            LrclibLyricsProvider(),
            PisniLyricsProvider(),
            TekstPesenokLyricsProvider(),
        ),
        recognition_provider=SourceRecognition(),
    )
    response: dict[str, object]
    try:
        song = app.songs.import_song.execute(
            ImportSongRequest(
                incoming / source_name,
                title=str(metadata["title"]),
                artist=str(metadata["artist"]),
                language=Language(metadata["language"]),
            )
        )
        if isinstance(metadata.get("embeddedLyrics"), str):
            song = replace(song, embedded_lyrics=metadata["embeddedLyrics"])
            with app.database.create() as transaction:
                transaction.songs.update(song)
                transaction.commit()
        projects = LocalProjectStorage(roots)
        previous = payload.get("previousProvenance")
        if isinstance(previous, dict) and (incoming / "lyricsBaseline.json").is_file():
            # Seed the previous text as another immutable revision, preserving manual-edit guards.
            manifest = projects.load_manifest(song.song_id, 1)
            artifacts = list(manifest.artifacts)
            files = {}
            for name in ["lyricsSync", "lyricsBaseline"]:
                source = incoming / (name + ".json")
                if source.is_file():
                    decode_document(source.read_text(encoding="utf-8"))
                    artifacts.append(
                        ProjectArtifact(
                            name,
                            Path(name + ".json"),
                            ArtifactCategory.PORTABLE,
                            sha256_file(source),
                        )
                    )
                    files[Path(name + ".json")] = source
            manifest = replace(
                manifest, revision=2, artifacts=tuple(artifacts), provenance=previous
            )
            working = projects.stage_revision(
                song.song_id,
                2,
                files,
                {
                    Path("source.ref"): str(song.source_path),
                    Path("manifest.json"): encode_manifest(manifest),
                },
            )
            projects.publish_revision(song.song_id, 2, working)
            song = replace(song, active_revision=2)
            with app.database.create() as transaction:
                transaction.songs.update(song)
                transaction.projects.add(
                    ProjectRevision(
                        song.song_id,
                        2,
                        manifest_fingerprint(manifest),
                        manifest.project_format_version,
                        uuid.uuid4().hex,
                        datetime.now(timezone.utc),
                    )
                )
                transaction.commit()
        job = app.songs.start_processing.execute(
            song.song_id,
            ProcessingMode(payload["mode"]),
            online_lyrics=bool(payload["onlineLyrics"]),
            idempotency_key=None,
            correlation_id=None,
        )
        last_progress: dict[str, object] | None = None
        while True:
            job = app.system.jobs.get(job.job_id)
            progress = {
                "stage": job.stage or "DecodeNormalize",
                "stageProgress": job.stage_progress,
                "overallProgress": job.overall_progress,
            }
            if progress != last_progress:
                atomic_write_text(Path(payload["progressPath"]), dumps(progress))
                last_progress = progress
            if job.terminal:
                break
            time.sleep(0.5)
        if job.state is not JobState.SUCCEEDED:
            response = {
                "protocolVersion": 1,
                "error": dict(
                    job.error or {"code": "ProcessingFailed", "message": "Song processing failed"}
                ),
            }
        else:
            song = app.songs.get_song.execute(song.song_id)
            manifest = projects.load_manifest(song.song_id, song.active_revision)
            outputs = {
                "instrumental.flac": "instrumental",
                "vocals.flac": "referenceVocal",
                "melody.flac": "melody",
                "lyrics.json": "lyricsSync",
            }
            for name, logical_name in outputs.items():
                shutil.copyfile(
                    projects.artifact_path(song.song_id, song.active_revision, logical_name),
                    directory / name,
                )
            response = {
                "protocolVersion": 1,
                "report": dict(job.report or {}),
                "provenance": dict(manifest.provenance),
            }
    except DomainError as error:
        response = {"protocolVersion": 1, "error": {"code": error.code, "message": error.message}}
    finally:
        app.shutdown()
    (directory / "output.json").write_text(dumps(response), encoding="utf-8")
    shutil.rmtree(directory / "runtime")


def main() -> None:
    settings = dotenv_values(
        Path(__file__).parents[2] / "local-secrets" / "env" / "processing-worker.env"
    )
    root = Path(
        os.environ.get("AD_VOICE_PROCESSING_WORKER_DATA")
        or settings.get("AD_VOICE_PROCESSING_WORKER_DATA")
        or "E:/ADVoiceData/ProcessingWorker"
    )
    if not Path("E:/").is_dir() or root.drive.upper() != "E:":
        raise RuntimeError("The processing worker requires its data and caches on E:")
    for name in ["temp", "sessions", "cache"]:
        (root / name).mkdir(parents=True, exist_ok=True)
    if sys.argv[1:] == ["--stop"]:
        (root / "stop.request").touch()
        return
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
    models = Path(settings.get("AD_VOICE_MODELS") or "E:/ADVoiceData/AD Voice/backend-data/models")
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
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable on the processing PC")
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
    logger.info("Processing worker ready: %s", torch.cuda.get_device_name(0))
    try:
        while not stop.is_set():
            if (root / "stop.request").exists():
                break
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
            try:
                ticket = transport.request("POST", "/worker/claim").json().get("job")
                if ticket:
                    logger.info("Starting processing job %s", ticket["jobId"])
                    run_job(transport, ticket, root, stop)
                    continue
            except (httpx.HTTPError, DomainError):
                logger.warning("Processing relay unavailable; retrying in 15 seconds")
            stop.wait(15)
    finally:
        transport.close()
        lock.release()


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--process-song":
        process_song_task(Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        main()
