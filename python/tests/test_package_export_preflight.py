from __future__ import annotations

import hashlib
import shutil
import zipfile
from dataclasses import replace
from pathlib import Path

import pytest

from backend.processing.domain import JobType
from backend.infrastructure.local_projects import LocalProjectStorage
from backend.projects.domain import ArtifactCategory, ProjectArtifact, ProjectManifest
from backend.projects.manifest_codec import encode_manifest
from backend.storage.domain import StorageRoots
from backend.version import PROJECT_FORMAT_VERSION
from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.helpers import wait_for_job
from tests.test_packages_e2e import make_ready_and_export


def test_package_export_reserves_space_for_the_selected_clip_and_its_snapshot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"\x00\x00\x00\x18ftyp" + bytes(64_000))
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song, _ = make_ready_and_export(client, source)
        starter = client.app.state.container.packages.start_export
        preflight = starter._preflight
        without_clip = preflight.execute(song["songId"], None)
        updated = client.patch(f"/songs/{song['songId']}", json={"videoPath": str(clip)})
        assert updated.status_code == 200, updated.text
        monkeypatch.setattr(
            preflight._storage,
            "free_bytes",
            lambda _path: preflight._margin + without_clip * 2,
        )

        response = client.post(f"/packages/export/{song['songId']}")

        assert response.status_code == 503, response.text
        assert response.json()["code"] == "InsufficientDiskSpace"
        with preflight._uow.create() as transaction:
            assert transaction.jobs.count(job_type=JobType.PACKAGE_EXPORT) == 1


@pytest.mark.parametrize("selected_size", [16_000, 32_000, 64_000])
def test_package_export_counts_a_portable_clip_once_with_the_selected_size(
    tmp_path: Path, selected_size: int
) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    clip = tmp_path / "selected.mp4"
    clip.write_bytes(b"\x00\x00\x00\x18ftyp" + bytes(selected_size))
    runtime = tmp_path / "runtime"
    with app_client(runtime, ai_providers=(FakeAiProvider(),)) as client:
        song, _ = make_ready_and_export(client, source)
        updated = client.patch(f"/songs/{song['songId']}", json={"videoPath": str(clip)})
        assert updated.status_code == 200, updated.text
        revision = updated.json()["activeRevision"]
        preflight = client.app.state.container.packages.start_export._preflight
        projects = preflight._projects
        manifest = projects.load_manifest(song["songId"], revision)
        project = runtime / "songs" / song["songId"] / "revisions" / str(revision)
        archived_clip = project / "media/clip.mp4"
        archived_clip.parent.mkdir(parents=True, exist_ok=True)
        archived_clip.write_bytes(b"\x00\x00\x00\x18ftyp" + bytes(32_000))
        artifact = ProjectArtifact(
            "clip",
            Path("media/clip.mp4"),
            ArtifactCategory.PORTABLE,
            hashlib.sha256(archived_clip.read_bytes()).hexdigest(),
        )
        (project / "manifest.json").write_text(
            encode_manifest(replace(manifest, artifacts=(*manifest.artifacts, artifact))),
            encoding="utf-8",
        )
        base_size = projects.portable_revision_size(song["songId"], revision)

        required = preflight.execute(song["songId"], revision)

        assert required == base_size - archived_clip.stat().st_size + clip.stat().st_size


def test_reexport_after_a_smaller_manual_clip_does_not_copy_the_archived_clip(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    original_clip = tmp_path / "original.mp4"
    original_clip.write_bytes(b"\x00\x00\x00\x18ftyp" + bytes(2_000_000))
    replacement = tmp_path / "smaller.mp4"
    replacement.write_bytes(b"\x00\x00\x00\x18ftypreplacement")
    with app_client(tmp_path / "source", ai_providers=(FakeAiProvider(),)) as client:
        song, _ = make_ready_and_export(client, source)
        assert (
            client.patch(
                f"/songs/{song['songId']}", json={"videoPath": str(original_clip)}
            ).status_code
            == 200
        )
        started = client.post(f"/packages/export/{song['songId']}")
        package = Path(wait_for_job(client, started.json()["jobId"])["report"]["path"])

    runtime = tmp_path / "relay"
    with app_client(runtime) as client:
        started = client.post("/packages/import", json={"path": str(package)})
        imported = wait_for_job(client, started.json()["jobId"])
        assert imported["state"] == "Succeeded", imported
        changed = client.patch(f"/songs/{song['songId']}", json={"videoPath": str(replacement)})
        assert changed.status_code == 200, changed.text
        revision = changed.json()["activeRevision"]
        archived_clip = (
            runtime / "songs" / song["songId"] / "revisions" / str(revision) / "media/clip.mp4"
        )
        assert archived_clip.stat().st_size > 100 * replacement.stat().st_size
        copy = shutil.copyfile

        def copy_selected(source, destination, *, follow_symlinks=True):
            assert Path(source) != archived_clip, "Export copied the obsolete archived clip"
            return copy(source, destination, follow_symlinks=follow_symlinks)

        with monkeypatch.context() as patch:
            patch.setattr(shutil, "copyfile", copy_selected)
            preflight = client.app.state.container.packages.start_export._preflight
            selected_bytes = preflight.execute(song["songId"], revision)
            patch.setattr(
                preflight._storage,
                "free_bytes",
                lambda _path: preflight._margin + 2 * selected_bytes,
            )
            started = client.post(f"/packages/export/{song['songId']}")
            exported = wait_for_job(client, started.json()["jobId"])
        assert exported["state"] == "Succeeded", exported
        relayed = Path(exported["report"]["path"])
        with zipfile.ZipFile(relayed) as archive:
            assert archive.read("media/clip.mp4") == replacement.read_bytes()

    with app_client(tmp_path / "target") as client:
        started = client.post("/packages/import", json={"path": str(relayed)})
        imported = wait_for_job(client, started.json()["jobId"])
        assert imported["state"] == "Succeeded", imported
        assert client.get(f"/songs/{song['songId']}/clip").content == replacement.read_bytes()


def test_portable_package_snapshot_omits_local_files_and_preserves_full_snapshot_default(
    tmp_path: Path,
) -> None:
    projects = LocalProjectStorage(StorageRoots.under(tmp_path / "runtime"))
    working = projects.begin_revision("song", 1)
    artifacts = (
        ProjectArtifact("audio", Path("audio.wav"), ArtifactCategory.PORTABLE),
        ProjectArtifact("source", Path("source.ref"), ArtifactCategory.LOCAL_ONLY),
        ProjectArtifact("cache", Path("cache.json"), ArtifactCategory.TEMPORARY),
    )
    for artifact in artifacts:
        (working / artifact.relative_path).write_text(artifact.logical_name)
    manifest = ProjectManifest(PROJECT_FORMAT_VERSION, "song", 1, artifacts, {})
    (working / "manifest.json").write_text(encode_manifest(manifest), encoding="utf-8")
    (working / "media").mkdir()
    (working / "media/clip.mp4").write_bytes(b"old clip")
    projects.publish_revision("song", 1, working)
    replacement = tmp_path / "selected.mp4"
    replacement.write_bytes(b"selected clip")

    portable = projects.snapshot_revision(
        "song",
        1,
        tmp_path / "portable",
        supplemental_files={Path("media/clip.mp4"): replacement},
        portable_only=True,
    )
    complete = projects.snapshot_revision("song", 1, tmp_path / "complete")

    assert {
        path.relative_to(portable).as_posix() for path in portable.rglob("*") if path.is_file()
    } == {"manifest.json", "audio.wav", "media/clip.mp4"}
    assert (portable / "media/clip.mp4").read_bytes() == b"selected clip"
    assert (complete / "source.ref").read_text() == "source"
    assert (complete / "cache.json").read_text() == "cache"
    assert (complete / "media/clip.mp4").read_bytes() == b"old clip"
