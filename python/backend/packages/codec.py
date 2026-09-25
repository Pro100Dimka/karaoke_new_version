from __future__ import annotations

from backend.serialization import JsonValue, dumps, loads_object
from backend.packages.domain import PackageArtifact, PackageManifest, PackageSongIdentity
from backend.songs.domain import Language
from backend.storage.path_policy import portable_component, portable_relative_path


def encode_manifest(manifest: PackageManifest) -> str:
    return dumps(
        {
            "packageVersion": manifest.package_version,
            "projectFormatVersion": manifest.project_format_version,
            "songIdentity": {
                "songId": manifest.song.song_id,
                "sourceIdentity": manifest.song.source_identity,
                "title": manifest.song.title,
                "artist": manifest.song.artist,
                "duration": manifest.song.duration,
                "language": manifest.song.language,
                "album": manifest.song.album,
                "genre": manifest.song.genre,
                "artworkUrl": manifest.song.artwork_url,
                "videoUrl": manifest.song.video_url,
                "recognitionProvider": manifest.song.recognition_provider,
                "recognitionExternalId": manifest.song.recognition_external_id,
            },
            "revision": manifest.revision,
            "revisionFingerprint": manifest.revision_fingerprint,
            "lineageId": manifest.lineage_id,
            "artifacts": [
                {"path": item.path.as_posix(), "checksum": item.checksum}
                for item in manifest.artifacts
            ],
        }
    )


def decode_manifest(raw: str) -> PackageManifest:
    data = loads_object(raw)
    song_raw = _mapping(data.get("songIdentity"), "songIdentity")
    artifacts_raw = _list(data.get("artifacts"), "artifacts")
    return PackageManifest(
        package_version=_integer(data.get("packageVersion"), "packageVersion"),
        project_format_version=_integer(data.get("projectFormatVersion"), "projectFormatVersion"),
        song=PackageSongIdentity(
            song_id=portable_component(_text(song_raw.get("songId"), "songId")),
            source_identity=_text(song_raw.get("sourceIdentity"), "sourceIdentity"),
            title=_text(song_raw.get("title"), "title"),
            artist=_text(song_raw.get("artist"), "artist"),
            duration=_optional_number(song_raw.get("duration")),
            language=Language(_text(song_raw.get("language"), "language")),
            album=_optional_text(song_raw.get("album"), "album"),
            genre=_optional_text(song_raw.get("genre"), "genre"),
            artwork_url=_optional_text(song_raw.get("artworkUrl"), "artworkUrl"),
            video_url=_optional_text(song_raw.get("videoUrl"), "videoUrl"),
            recognition_provider=_optional_text(
                song_raw.get("recognitionProvider"), "recognitionProvider"
            ),
            recognition_external_id=_optional_text(
                song_raw.get("recognitionExternalId"), "recognitionExternalId"
            ),
        ),
        revision=_integer(data.get("revision"), "revision"),
        revision_fingerprint=_text(data.get("revisionFingerprint"), "revisionFingerprint"),
        lineage_id=_text(data.get("lineageId"), "lineageId"),
        artifacts=tuple(_artifact(item) for item in artifacts_raw),
    )


def _artifact(value: JsonValue) -> PackageArtifact:
    data = _mapping(value, "artifact")
    return PackageArtifact(
        portable_relative_path(_text(data.get("path"), "path")),
        _text(data.get("checksum"), "checksum"),
    )


def _mapping(value: JsonValue, name: str) -> dict[str, JsonValue]:
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    return value


def _list(value: JsonValue, name: str) -> list[JsonValue]:
    if not isinstance(value, list):
        raise ValueError(f"{name} must be an array")
    return value


def _text(value: JsonValue, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{name} must be non-empty text")
    return value


def _integer(value: JsonValue, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} must be a non-negative integer")
    return value


def _optional_text(value: JsonValue, name: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value:
        raise ValueError(f"{name} must be non-empty text or null")
    return value


def _optional_number(value: JsonValue) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ValueError("duration must be numeric")
    return float(value)
