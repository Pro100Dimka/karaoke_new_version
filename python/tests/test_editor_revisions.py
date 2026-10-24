from __future__ import annotations

import pytest
import json
from pathlib import Path
from dataclasses import replace

from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.helpers import import_song, wait_for_job


pytestmark = pytest.mark.integration


def ready_song(client, source: Path) -> dict[str, object]:
    song = import_song(client, source)
    response = client.post(
        f"/songs/{song['songId']}/processing",
        json={"mode": "Fast", "onlineLyrics": False},
    )
    assert response.status_code == 202, response.text
    job = wait_for_job(client, response.json()["jobId"])
    assert job["state"] == "Succeeded", job
    return client.get(f"/songs/{song['songId']}").json()


def test_editor_api_round_trips_the_measured_karaoke_target(tmp_path: Path) -> None:
    source = tmp_path / "target.wav"
    write_wav(source)

    class RhythmProvider(FakeAiProvider):
        def separate(self, *args, **kwargs):
            return replace(super().separate(*args, **kwargs), rhythm=((0.2, 1), (0.7, 0.7)))

    with app_client(tmp_path / "runtime", ai_providers=(RhythmProvider(),)) as client:
        song = ready_song(client, source)
        song_id = str(song["songId"])
        measured = client.app.state.container.songs.get_editor.execute(song_id).document
        assert measured.vocal_activity
        assert measured.words[0].notes[0].contour
        opened = client.get(f"/songs/{song_id}/editor").json()
        document = opened["document"]
        assert document["rhythm"] == [[0.2, 1], [0.7, 0.7]]
        assert document.get("vocalActivity") == [
            list(interval) for interval in measured.vocal_activity
        ]
        assert document["words"][0]["notes"][0].get("contour") == [
            list(point) for point in measured.words[0].notes[0].contour
        ]
        saved = client.put(
            f"/songs/{song_id}/editor",
            json={"expectedRevision": opened["revision"], "document": document},
        )
        assert saved.status_code == 200, saved.text
        restored = client.app.state.container.songs.get_editor.execute(song_id).document
        assert restored.rhythm == measured.rhythm
        assert restored.vocal_activity == measured.vocal_activity
        assert restored.words[0].notes[0].contour == measured.words[0].notes[0].contour


def test_editor_save_requires_expected_revision(tmp_path: Path) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song = ready_song(client, source)
        opened = client.get(f"/songs/{song['songId']}/editor")
        assert opened.status_code == 200, opened.text
        editor = opened.json()
        document = editor["document"]
        document["words"][0]["notes"][0]["note"] = 70

        saved = client.put(
            f"/songs/{song['songId']}/editor",
            json={"expectedRevision": editor["revision"], "document": document},
        )
        assert saved.status_code == 200, saved.text
        assert saved.json()["revision"] == editor["revision"] + 1

        stale = client.put(
            f"/songs/{song['songId']}/editor",
            json={"expectedRevision": editor["revision"], "document": document},
        )
        assert stale.status_code == 409
        assert stale.json()["code"] == "RevisionConflict"


def test_editor_reset_restores_ai_baseline_as_new_revision(tmp_path: Path) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song = ready_song(client, source)
        opened = client.get(f"/songs/{song['songId']}/editor").json()
        original_note = opened["document"]["words"][0]["notes"][0]["note"]
        changed = opened["document"]
        changed["words"][0]["notes"][0]["note"] = original_note + 5
        saved = client.put(
            f"/songs/{song['songId']}/editor",
            json={"expectedRevision": opened["revision"], "document": changed},
        ).json()

        reset = client.post(
            f"/songs/{song['songId']}/editor/reset",
            json={"expectedRevision": saved["revision"]},
        )
        assert reset.status_code == 200, reset.text
        current = client.get(f"/songs/{song['songId']}/editor").json()

        assert current["revision"] == saved["revision"] + 1
        assert current["document"]["words"][0]["notes"][0]["note"] == original_note


@pytest.mark.parametrize("manual,baseline", [(True, True), (False, True), (True, False)])
def test_generated_reprocessing_preserves_legacy_edits_without_manifest_checksums(
    tmp_path: Path, manual: bool, baseline: bool
) -> None:
    source = tmp_path / "legacy.wav"
    write_wav(source)
    root = tmp_path / "runtime"
    with app_client(root, ai_providers=(FakeAiProvider(),)) as client:
        song = ready_song(client, source)
        editor_path = f"/songs/{song['songId']}/editor"
        before = client.get(editor_path).json()
        if manual:
            before["document"]["words"][0]["notes"][0]["note"] = 70
            saved = client.put(
                editor_path,
                json={
                    "expectedRevision": before["revision"],
                    "document": before["document"],
                },
            )
            assert saved.status_code == 200, saved.text
        before = client.get(editor_path).json()
        project = root / "songs" / song["songId"] / "revisions" / str(before["revision"])
        manifest_path = project / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["artifacts"] = [
            item
            for item in manifest["artifacts"]
            if baseline or item["logicalName"] != "lyricsBaseline"
        ]
        for item in manifest["artifacts"]:
            if item["logicalName"] in {"lyricsSync", "lyricsBaseline"}:
                item["checksum"] = None
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        started = client.post(f"/songs/{song['songId']}/processing/lyrics")
        # The existing Ready validation explicitly permits these optional manifest checksums.
        assert started.status_code == 202, started.text
        job = wait_for_job(client, started.json()["jobId"])
        if manual or not baseline:
            assert job["state"] == "Failed", job
            assert job["error"]["code"] == "ManualLyricsConflict"
            assert client.get(editor_path).json() == before
            assert not project.with_name(str(before["revision"] + 1)).exists()
        else:
            assert job["state"] == "Succeeded", job
            assert client.get(editor_path).json()["revision"] == before["revision"] + 1
        if manual and baseline:
            reset = client.post(
                f"{editor_path}/reset", json={"expectedRevision": before["revision"]}
            )
            assert reset.status_code == 200, reset.text
            restarted = client.post(f"/songs/{song['songId']}/processing/lyrics")
            assert wait_for_job(client, restarted.json()["jobId"])["state"] == "Succeeded"


def test_editor_save_shares_unchanged_files_with_the_previous_revision(tmp_path: Path) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song = ready_song(client, source)
        editor = client.get(f"/songs/{song['songId']}/editor").json()
        document = editor["document"]
        document["words"][0]["notes"][0]["note"] = 70
        saved = client.put(
            f"/songs/{song['songId']}/editor",
            json={"expectedRevision": editor["revision"], "document": document},
        )
        assert saved.status_code == 200, saved.text

    revisions = tmp_path / "runtime" / "songs" / str(song["songId"]) / "revisions"
    before = revisions / str(editor["revision"])
    after = revisions / str(saved.json()["revision"])
    old_files = {p.relative_to(before): p for p in before.rglob("*") if p.is_file()}
    new_files = {p.relative_to(after): p for p in after.rglob("*") if p.is_file()}
    assert old_files.keys() == new_files.keys()
    changed = {
        relative for relative in old_files if not old_files[relative].samefile(new_files[relative])
    }
    # Only the lyrics and the manifest are new; the audio is shared, not copied.
    assert Path("manifest.json") in changed
    assert len(changed) == 2, changed
    for relative in changed:
        assert old_files[relative].read_bytes() != new_files[relative].read_bytes()


@pytest.mark.parametrize("start,end", [(-0.1, 0.5), (0.5, 1.1), (0.5, 0.5)])
def test_invalid_editor_timing_is_rejected_without_publishing_a_revision(
    tmp_path: Path, start: float, end: float
) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song = ready_song(client, source)
        path = f"/songs/{song['songId']}/editor"
        opened = client.get(path).json()
        invalid = dict(opened["document"])
        invalid["words"] = [{"text": "la", "start": start, "end": end, "notes": []}]
        response = client.put(
            path, json={"expectedRevision": opened["revision"], "document": invalid}
        )
        assert response.status_code == 422, response.text
        assert response.json()["code"] == "ValidationError"
        assert client.get(path).json() == opened

    revisions = tmp_path / "runtime" / "songs" / str(song["songId"]) / "revisions"
    assert not (revisions / str(opened["revision"] + 1)).exists()


def test_editor_cannot_extend_the_song_duration_to_publish_words_past_the_audio(
    tmp_path: Path,
) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song = ready_song(client, source)
        path = f"/songs/{song['songId']}/editor"
        opened = client.get(path).json()
        invalid = dict(opened["document"])
        invalid["duration"] = 2.0
        invalid["words"] = [{"text": "la", "start": 1.5, "end": 2.0, "notes": []}]
        response = client.put(
            path, json={"expectedRevision": opened["revision"], "document": invalid}
        )
        assert response.status_code == 422, response.text
        assert client.get(path).json() == opened
