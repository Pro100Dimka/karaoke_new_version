from __future__ import annotations

from pathlib import Path

from backend.serialization import JsonValue, dumps, loads_object
from backend.projects.domain import ArtifactCategory, ProjectArtifact, ProjectManifest


def encode_manifest(manifest: ProjectManifest) -> str:
    return dumps(
        {
            "projectFormatVersion": manifest.project_format_version,
            "songId": manifest.song_id,
            "revision": manifest.revision,
            "artifacts": [
                {
                    "logicalName": artifact.logical_name,
                    "relativePath": artifact.relative_path.as_posix(),
                    "category": artifact.category,
                    "checksum": artifact.checksum,
                    "version": artifact.version,
                    "provenance": artifact.provenance,
                }
                for artifact in manifest.artifacts
            ],
            "provenance": manifest.provenance,
        }
    )


def decode_manifest(raw: str) -> ProjectManifest:
    data = loads_object(raw)
    artifacts_raw = _require_list(data, "artifacts")
    artifacts = tuple(_decode_artifact(item) for item in artifacts_raw)
    provenance = _require_mapping(data, "provenance")
    return ProjectManifest(
        project_format_version=_require_int(data, "projectFormatVersion"),
        song_id=_require_str(data, "songId"),
        revision=_require_int(data, "revision"),
        artifacts=artifacts,
        provenance=provenance,
    )


def _decode_artifact(value: JsonValue) -> ProjectArtifact:
    if not isinstance(value, dict):
        raise ValueError("Manifest artifact must be an object")
    return ProjectArtifact(
        logical_name=_require_str(value, "logicalName"),
        relative_path=Path(_require_str(value, "relativePath")),
        category=ArtifactCategory(_require_str(value, "category")),
        checksum=_optional_str(value.get("checksum")),
        version=_optional_str(value.get("version")),
        provenance=_optional_mapping(value.get("provenance")),
    )


def _require_str(data: dict[str, JsonValue], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{key} must be a non-empty string")
    return value


def _require_int(data: dict[str, JsonValue], key: str) -> int:
    value = data.get(key)
    if not isinstance(value, int):
        raise ValueError(f"{key} must be an integer")
    return value


def _require_list(data: dict[str, JsonValue], key: str) -> list[JsonValue]:
    value = data.get(key)
    if not isinstance(value, list):
        raise ValueError(f"{key} must be an array")
    return value


def _require_mapping(data: dict[str, JsonValue], key: str) -> dict[str, object]:
    value = data.get(key)
    if not isinstance(value, dict):
        raise ValueError(f"{key} must be an object")
    return dict(value)


def _optional_str(value: JsonValue) -> str | None:
    return value if isinstance(value, str) else None


def _optional_mapping(value: JsonValue) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    if not all(isinstance(item, str) for item in value.values()):
        raise ValueError("Artifact provenance values must be strings")
    return {key: item for key, item in value.items() if isinstance(item, str)}
