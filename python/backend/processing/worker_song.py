"""Complete a remote song using the ordinary local pipeline in disposable storage."""

from __future__ import annotations
import os
import shutil
import time
from pathlib import Path
from backend.domain_errors import DomainError
from backend.serialization import dumps, loads_object, JsonValue
from backend.bootstrap.container import ApplicationContainer
from backend.songs.domain import Song
from backend.processing.domain import Job
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
from backend.projects.domain import (
    ArtifactCategory,
    ProjectArtifact,
    ProjectRevision,
    ProjectManifest,
)
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


def _load_task(incoming: Path) -> tuple[dict[str, JsonValue], str, dict[str, JsonValue]]:
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
    return payload, source_name, metadata


def _build_app(roots: StorageRoots) -> ApplicationContainer:
    config = BackendConfig(
        roots, ResourceBudget(max_background_jobs=1), PackagePolicy(), ApiPolicy()
    )
    return build_container(
        config,
        lyrics_providers=(
            LrclibLyricsProvider(),
            PisniLyricsProvider(),
            TekstPesenokLyricsProvider(),
        ),
        recognition_provider=SourceRecognition(),
    )


def _import_song(
    app: ApplicationContainer, incoming: Path, source_name: str, metadata: dict[str, JsonValue]
) -> Song:
    song = app.songs.import_song.execute(
        ImportSongRequest(
            incoming / source_name,
            title=str(metadata["title"]),
            artist=str(metadata["artist"]),
            language=Language(str(metadata["language"])),
        )
    )
    embedded = metadata.get("embeddedLyrics")
    if isinstance(embedded, str):
        song = replace(song, embedded_lyrics=embedded)
        with app.database.create() as transaction:
            transaction.songs.update(song)
            transaction.commit()
    return song


def _previous_artifacts(
    manifest: ProjectManifest, incoming: Path
) -> tuple[list[ProjectArtifact], dict[Path, Path]]:
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
    return artifacts, files


def _seed_previous(
    app: ApplicationContainer,
    projects: LocalProjectStorage,
    song: Song,
    incoming: Path,
    payload: dict[str, JsonValue],
) -> Song:
    previous = payload.get("previousProvenance")
    if isinstance(previous, dict) and (incoming / "lyricsBaseline.json").is_file():
        # Seed the previous text as another immutable revision, preserving manual-edit guards.
        manifest = projects.load_manifest(song.song_id, 1)
        artifacts, files = _previous_artifacts(manifest, incoming)
        manifest = replace(manifest, revision=2, artifacts=tuple(artifacts), provenance=previous)
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
    return song


def _wait_for_song(app: ApplicationContainer, song: Song, payload: dict[str, JsonValue]) -> Job:
    job = app.songs.start_processing.execute(
        song.song_id,
        ProcessingMode(str(payload["mode"])),
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
            atomic_write_text(Path(str(payload["progressPath"])), dumps(progress))
            last_progress = progress
        if job.terminal:
            break
        time.sleep(0.5)
    return job


def _song_result(
    app: ApplicationContainer, projects: LocalProjectStorage, song: Song, job: Job, directory: Path
) -> dict[str, object]:
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
    return response


def process_song_task(incoming: Path, directory: Path) -> None:
    """Use the same complete local processing pipeline in an isolated disposable library."""
    payload, source_name, metadata = _load_task(incoming)
    roots = replace(
        StorageRoots.under(directory / "runtime"), models=Path(os.environ["AD_VOICE_MODELS"])
    )
    app = _build_app(roots)
    response: dict[str, object]
    try:
        song = _import_song(app, incoming, source_name, metadata)
        projects = LocalProjectStorage(roots)
        song = _seed_previous(app, projects, song, incoming, payload)
        job = _wait_for_song(app, song, payload)
        response = _song_result(app, projects, song, job, directory)
    except DomainError as error:
        response = {"protocolVersion": 1, "error": {"code": error.code, "message": error.message}}
    finally:
        app.shutdown()
    (directory / "output.json").write_text(dumps(response), encoding="utf-8")
    shutil.rmtree(directory / "runtime")
