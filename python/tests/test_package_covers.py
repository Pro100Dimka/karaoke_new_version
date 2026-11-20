from __future__ import annotations

import hashlib
import json
import zipfile
from dataclasses import replace
from pathlib import Path, PurePosixPath

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import SQLAlchemyError

from backend.domain_errors import DomainError
from backend.infrastructure.local_songs import LocalSongStorage
from backend.infrastructure.sql_songs import SqlSongRepository
from backend.lyrics.codec import encode_document
from backend.lyrics.domain import LyricsDocument
from backend.packages.codec import decode_manifest as decode_package
from backend.packages.codec import encode_manifest as encode_package
from backend.packages.domain import PackageArtifact, PackageManifest, PackageSongIdentity
from backend.projects.domain import ArtifactCategory, ProjectArtifact, ProjectManifest
from backend.projects.fingerprint import manifest_fingerprint
from backend.projects.manifest_codec import encode_manifest
from backend.songs.domain import CoverState, Language
from backend.version import PACKAGE_FORMAT_VERSION, PROJECT_FORMAT_VERSION
from tests.conftest import app_client, write_wav
from tests.test_song_cover_versions import _png

pytestmark = pytest.mark.integration
SONG_ID = "package-cover-song"
COVER_PATH = "song-media/cover.png"
INCOMING_COVER = _png(230, 40, 40)
LOCAL_COVER = _png(30, 60, 220)


def _package(root: Path, *, revision: int = 1, cover: bytes | None = None) -> Path:
    """Build a tiny ready project directly: cover tests never run song processing or AI."""
    root.mkdir(parents=True, exist_ok=True)
    wave = root / "tone.wav"
    write_wav(wave, seconds=0.1)
    files = {
        "audio/instrumental.wav": wave.read_bytes(),
        "audio/reference-vocal.wav": wave.read_bytes(),
        "lyricsSync.json": encode_document(
            LyricsDocument("Cover song", "Artist", 0.1, None, None, "", ())
        ).encode(),
    }
    project = ProjectManifest(
        PROJECT_FORMAT_VERSION,
        SONG_ID,
        revision,
        tuple(
            ProjectArtifact(name, Path(path), ArtifactCategory.PORTABLE, _hash(files[path]))
            for name, path in (
                ("instrumental", "audio/instrumental.wav"),
                ("referenceVocal", "audio/reference-vocal.wav"),
                ("lyricsSync", "lyricsSync.json"),
            )
        ),
        {},
    )
    files["manifest.json"] = encode_manifest(project).encode()
    if cover is not None:
        files[COVER_PATH] = cover
    manifest = PackageManifest(
        PACKAGE_FORMAT_VERSION,
        PROJECT_FORMAT_VERSION,
        PackageSongIdentity(
            SONG_ID, _hash(wave.read_bytes()), "Cover song", "Artist", 0.1, Language.AUTO
        ),
        revision,
        manifest_fingerprint(project),
        SONG_ID,
        tuple(PackageArtifact(PurePosixPath(path), _hash(data)) for path, data in files.items()),
    )
    raw = json.loads(encode_package(manifest))
    if cover is not None:
        raw["songIdentity"]["customCover"] = COVER_PATH
    else:
        raw["songIdentity"].pop("customCover", None)
    files["package.json"] = json.dumps(raw).encode()
    target = root / "song.advoice.zip"
    _write_zip(target, files)
    return target


def _write_zip(target: Path, files: dict[str, bytes]) -> None:
    with zipfile.ZipFile(target, "w") as bundle:
        for path, contents in files.items():
            bundle.writestr(path, contents)


def _files(package: Path) -> dict[str, bytes]:
    with zipfile.ZipFile(package) as bundle:
        return {name: bundle.read(name) for name in bundle.namelist()}


def _hash(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _import(client: TestClient, package: Path, **kwargs):
    return client.app.state.container.packages.start_import._import.execute(package, **kwargs)


def _song(client: TestClient):
    return client.app.state.container.songs.get_song.execute(SONG_ID)


def _set_cover(client: TestClient, source: Path, data: bytes = LOCAL_COVER) -> Path:
    source.write_bytes(data)
    result = client.patch(f"/songs/{SONG_ID}", json={"coverPath": str(source)})
    assert result.status_code == 200, result.text
    target = _song(client).cover_path
    assert target is not None and target.read_bytes() == data
    return target


def test_custom_cover_roundtrip_keeps_media_separate_from_revision_identity(tmp_path: Path) -> None:
    legacy = _package(tmp_path / "package")
    with app_client(tmp_path / "source") as client:
        _import(client, legacy)
        before = client.get(f"/songs/{SONG_ID}").json()
        _set_cover(client, tmp_path / "cover.png", INCOMING_COVER)
        export = client.app.state.container.packages.start_export._export
        package = export.execute(SONG_ID)
        files = _files(package)
        manifest = json.loads(files["package.json"])
        cover_path = manifest["songIdentity"].get("customCover")
        assert cover_path == COVER_PATH
        assert files[cover_path] == INCOMING_COVER
        assert next(
            item["checksum"] for item in manifest["artifacts"] if item["path"] == cover_path
        ) == _hash(INCOMING_COVER)
        original = json.loads(_files(legacy)["package.json"])
        assert manifest["revisionFingerprint"] == original["revisionFingerprint"]
        assert files["manifest.json"] == _files(legacy)["manifest.json"]
        assert manifest["packageVersion"] == PACKAGE_FORMAT_VERSION
        assert client.get(f"/songs/{SONG_ID}").json()["projectHash"] == before["projectHash"]

    with app_client(tmp_path / "target") as client:
        result = _import(client, package)
        assert result.created
        song = _song(client)
        assert song.cover_state is CoverState.CUSTOM
        assert "cover" in song.user_overrides
        assert song.cover_path == tmp_path / "target" / "songs" / SONG_ID / "cover" / "cover.png"
        assert client.get(f"/songs/{SONG_ID}/cover").content == INCOMING_COVER
        reexported = client.app.state.container.packages.start_export._export.execute(SONG_ID)
        assert _files(reexported)[COVER_PATH] == INCOMING_COVER


@pytest.mark.parametrize("revision", [1, 2])
@pytest.mark.parametrize("protection", ["custom", "override"])
def test_import_never_copies_over_a_local_cover_even_with_the_same_filename(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    revision: int,
    protection: str,
) -> None:
    _import(client, _package(tmp_path / "legacy"))
    path = _set_cover(client, tmp_path / "cover.png")
    before = _song(client)
    protected = replace(
        before,
        cover_state=CoverState.CUSTOM if protection == "custom" else CoverState.FALLBACK,
        user_overrides=frozenset() if protection == "custom" else frozenset({"cover"}),
    )
    with client.app.state.container.database.create() as transaction:
        transaction.songs.update(protected)
        transaction.commit()

    def forbidden_copy(*_args):
        pytest.fail("Package import must not copy any media over the protected cover")

    monkeypatch.setattr(LocalSongStorage, "copy_cover", forbidden_copy)
    package = _package(tmp_path / "incoming", revision=revision, cover=INCOMING_COVER)
    _import(client, package)
    after = _song(client)
    assert after.cover_path == path and path.read_bytes() == LOCAL_COVER
    assert after.cover_state is protected.cover_state
    assert after.user_overrides == protected.user_overrides
    assert after.active_revision == revision


def test_known_revision_can_gain_a_cover_without_replacing_its_project_files(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _import(client, _package(tmp_path / "legacy"))
    root = client.app.state.container.roots.songs / SONG_ID / "revisions"
    before = {
        path.relative_to(root): path.read_bytes() for path in root.rglob("*") if path.is_file()
    }
    package = _package(tmp_path / "incoming", cover=INCOMING_COVER)
    result = _import(client, package)
    assert not result.created and result.song.active_revision == 1
    assert client.get(f"/songs/{SONG_ID}/cover").content == INCOMING_COVER
    assert {
        path.relative_to(root): path.read_bytes() for path in root.rglob("*") if path.is_file()
    } == before

    def forbidden_copy(*_args):
        pytest.fail("Reimport must preserve the installed Custom cover")

    monkeypatch.setattr(LocalSongStorage, "copy_cover", forbidden_copy)
    _import(client, package)
    _import(client, _package(tmp_path / "old-package-without-cover"))
    assert client.get(f"/songs/{SONG_ID}/cover").content == INCOMING_COVER


@pytest.mark.parametrize("known", [False, True])
def test_corrupt_cover_is_rejected_before_catalog_or_cover_changes(
    client: TestClient,
    tmp_path: Path,
    known: bool,
) -> None:
    if known:
        _import(client, _package(tmp_path / "legacy"))
    package = _package(tmp_path / "incoming", cover=INCOMING_COVER)
    contents = _files(package)
    contents[COVER_PATH] = b"changed after the checksum was recorded"
    _write_zip(package, contents)
    with pytest.raises(DomainError) as error:
        _import(client, package)
    assert error.value.code == "PackageInvalid"
    if known:
        assert _song(client).cover_path is None
    else:
        assert client.get(f"/songs/{SONG_ID}").status_code == 404
    assert not (client.app.state.container.roots.songs / SONG_ID / "cover").exists()


@pytest.mark.parametrize("failure", ["database", "cancellation"])
@pytest.mark.parametrize("revision", [1, 2])
def test_failed_import_restores_same_name_media_and_removes_the_uncommitted_revision(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
    revision: int,
) -> None:
    _import(client, _package(tmp_path / "legacy"))
    before = _song(client)
    root = client.app.state.container.roots.songs / SONG_ID
    retained = root / "cover" / "cover.png"
    retained.parent.mkdir()
    retained.write_bytes(LOCAL_COVER)
    package = _package(tmp_path / "incoming", revision=revision, cover=INCOMING_COVER)
    calls = []
    copy = LocalSongStorage.copy_cover

    def observe_copy(storage, song_id, source):
        result = copy(storage, song_id, source)
        calls.append(result)
        assert result.read_bytes() == INCOMING_COVER
        return result

    monkeypatch.setattr(LocalSongStorage, "copy_cover", observe_copy)
    if failure == "database":

        def reject_update(*_args):
            raise SQLAlchemyError("Simulated catalog write failure")

        monkeypatch.setattr(SqlSongRepository, "update", reject_update)
        with pytest.raises(DomainError) as error:
            _import(client, package)
        assert error.value.code == "DatabaseReadFailed"
    else:

        def cancelled_after_publication():
            if calls:
                raise DomainError("Cancelled", "Cancelled before catalog publication", 409)

        with pytest.raises(DomainError, match="Cancelled before"):
            _import(client, package, ensure_not_cancelled=cancelled_after_publication)
    assert calls == [retained]
    assert retained.read_bytes() == LOCAL_COVER
    assert _song(client) == before
    assert not (root / "revisions" / "2").exists()


def test_import_rechecks_custom_cover_after_inspection(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _import(client, _package(tmp_path / "legacy"))
    package = _package(tmp_path / "incoming", cover=INCOMING_COVER)
    importer = client.app.state.container.packages.start_import._import
    inspect = importer._inspect.execute

    def inspect_then_save_cover(path):
        result = inspect(path)
        _set_cover(client, tmp_path / "cover.png")
        return result

    monkeypatch.setattr(importer._inspect, "execute", inspect_then_save_cover)
    _import(client, package)
    assert client.get(f"/songs/{SONG_ID}/cover").content == LOCAL_COVER


def test_export_preflight_counts_the_custom_cover_and_clip_snapshot(client, tmp_path: Path) -> None:
    _import(client, _package(tmp_path / "legacy"))
    preflight = client.app.state.container.packages.start_export._preflight
    base_size = preflight.execute(SONG_ID, None)
    _set_cover(client, tmp_path / "cover.png")
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"\x00\x00\x00\x18ftyp" + bytes(200))
    updated = client.patch(f"/songs/{SONG_ID}", json={"videoPath": str(clip)})
    assert updated.status_code == 200, updated.text
    assert preflight.execute(SONG_ID, None) == base_size + len(LOCAL_COVER) + clip.stat().st_size


@pytest.mark.parametrize(
    "invalid", ["../cover.png", "audio/instrumental.wav", "missing", "duplicate"]
)
def test_cover_metadata_requires_a_unique_declared_media_artifact(
    tmp_path: Path, invalid: str
) -> None:
    manifest = json.loads(
        _files(_package(tmp_path / "package", cover=INCOMING_COVER))["package.json"]
    )
    if invalid == "missing":
        manifest["artifacts"] = [
            item for item in manifest["artifacts"] if item["path"] != COVER_PATH
        ]
    elif invalid == "duplicate":
        manifest["artifacts"].append(
            next(item for item in manifest["artifacts"] if item["path"] == COVER_PATH)
        )
    else:
        manifest["songIdentity"]["customCover"] = invalid
    with pytest.raises(ValueError):
        decode_package(json.dumps(manifest))
