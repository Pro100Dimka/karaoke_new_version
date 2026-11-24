from __future__ import annotations

import hashlib
import json
import zipfile
from dataclasses import replace
from pathlib import Path

import pytest

from backend.domain_errors import ConflictError
from backend.projects.domain import ArtifactCategory, ProjectArtifact, ProjectManifest
from backend.projects.fingerprint import manifest_fingerprint
from backend.projects.manifest_codec import decode_manifest, encode_manifest
from backend.version import PROJECT_FORMAT_VERSION
from tests.test_package_covers import INCOMING_COVER, SONG_ID, _files, _import, _package, _write_zip

pytestmark = pytest.mark.integration
_CHUNK = 1024 * 1024
_LARGE_PATH = "data/large.bin"
_CONTENTS = b"package-content\0" * (3 * _CHUNK // 16 + 1)


def _large_package(root: Path, *, cover: bytes | None = None) -> Path:
    package = _package(root, cover=cover)
    files = {_LARGE_PATH: _CONTENTS, **_files(package)}
    project = decode_manifest(files["manifest.json"].decode())
    project = replace(
        project,
        artifacts=(
            ProjectArtifact(
                "large",
                Path(_LARGE_PATH),
                ArtifactCategory.PORTABLE,
                hashlib.sha256(_CONTENTS).hexdigest(),
            ),
            *project.artifacts,
        ),
    )
    files["manifest.json"] = encode_manifest(project).encode()
    manifest = json.loads(files["package.json"])
    manifest["revisionFingerprint"] = manifest_fingerprint(project)
    manifest["artifacts"] = [
        {"path": path, "checksum": hashlib.sha256(contents).hexdigest()}
        for path, contents in files.items()
        if path != "package.json"
    ]
    files["package.json"] = json.dumps(manifest).encode()
    _write_zip(package, files)
    return package


@pytest.mark.parametrize(
    ("stage", "same_revision"),
    [(stage, same) for stage in ("extract", "package-hash") for same in (False, True)]
    + [("project-hash", False)],
)
def test_import_cancels_within_a_large_artifact_before_publication(
    client, tmp_path, monkeypatch, stage, same_revision
):
    if same_revision:
        _import(client, _large_package(tmp_path / "seed"))
    package = _large_package(tmp_path / "incoming", cover=INCOMING_COVER)
    container = client.app.state.container
    importer = container.packages.start_import._import
    publication = importer._publication
    roots = container.roots
    with container.database.create() as transaction:
        before = transaction.songs.get(SONG_ID)
    consumed = 0
    cancelled = False
    in_hash = False

    def checkpoint():
        if cancelled:
            raise ConflictError("JobCancelled", "Package import was cancelled")

    def observe(size):
        nonlocal consumed, cancelled
        consumed += size
        if size:
            cancelled = True

    if stage == "extract":
        read = zipfile.ZipExtFile.read

        def observed_read(stream, size=-1):
            data = read(stream, size)
            if stream.name == _LARGE_PATH:
                observe(len(data))
            return data

        monkeypatch.setattr(zipfile.ZipExtFile, "read", observed_read)
    else:
        owner = publication if stage == "package-hash" else publication._validator
        name = "_verify_artifacts" if stage == "package-hash" else "validate_working"
        verify = getattr(owner, name)

        def observed_verify(*args, **kwargs):
            nonlocal in_hash
            in_hash = True
            try:
                return verify(*args, **kwargs)
            finally:
                in_hash = False

        monkeypatch.setattr(owner, name, observed_verify)
        open_file = Path.open

        class ReadProbe:
            def __init__(self, stream):
                self.stream = stream

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                self.stream.close()

            def read(self, size=-1):
                data = self.stream.read(size)
                observe(len(data))
                return data

        def observed_open(path, *args, **kwargs):
            stream = open_file(path, *args, **kwargs)
            return ReadProbe(stream) if in_hash and path.name == "large.bin" else stream

        monkeypatch.setattr(Path, "open", observed_open)

    with pytest.raises(ConflictError) as error:
        importer.execute(package, ensure_not_cancelled=checkpoint)
    assert error.value.code == "JobCancelled"
    with container.database.create() as transaction:
        assert transaction.songs.get(SONG_ID) == before
    assert not list(roots.temp.glob(f"import-{SONG_ID}-*"))
    assert not list(roots.temp.glob(f"supplement-{SONG_ID}-*"))
    assert not publication._journal.entries()
    assert publication.revision_exists(SONG_ID, 1) is same_revision
    assert not list((roots.songs / SONG_ID / "cover").glob("*"))
    if same_revision:
        assert (roots.songs / SONG_ID / "revisions" / "1" / _LARGE_PATH).read_bytes() == _CONTENTS
    assert consumed == _CHUNK, "Cancellation must stop this byte stream after its first chunk"
    if stage == "project-hash":
        # The shared validator must not retain this import's cancelled callback.
        working = tmp_path / "independent-validation"
        working.mkdir()
        (working / "unchanged.bin").write_bytes(b"independent")
        manifest = ProjectManifest(
            PROJECT_FORMAT_VERSION,
            "independent",
            1,
            (
                ProjectArtifact(
                    "unchanged",
                    Path("unchanged.bin"),
                    ArtifactCategory.PORTABLE,
                    hashlib.sha256(b"independent").hexdigest(),
                ),
            ),
            {},
        )
        publication._validator.validate_working(manifest, working, require_ready=False)
