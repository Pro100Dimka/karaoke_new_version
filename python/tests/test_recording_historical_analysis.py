from contextlib import contextmanager
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.analysis.domain import AnalysisResult, AnalysisState
from backend.analysis.queries import ListRecordingAnalyses
from backend.recordings.domain import Recording
from backend.version import ANALYSIS_ALGORITHM_VERSION
from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.helpers import wait_for_job
from tests.test_recordings_analysis import ready_song, register_recording


def _analyze(client, recording_id):
    response = client.post(f"/recordings/{recording_id}/analysis")
    assert response.status_code == 202, response.text
    job = wait_for_job(client, response.json()["jobId"])
    assert job["state"] == "Succeeded", job
    results = client.get(f"/recordings/{recording_id}/analyses").json()
    return next(item for item in results if item["analysisId"] == job["report"]["analysisId"])


def test_reanalysis_after_dirty_editor_save_keeps_the_recorded_reference(tmp_path, monkeypatch):
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song = ready_song(client, source)
        take = register_recording(client, song)
        first = _analyze(client, take["recordingId"])
        assert first["state"] == "Succeeded"
        editor_path = f"/songs/{song['songId']}/editor"
        editor = client.get(editor_path).json()
        changed_text = editor["document"]["words"][0]["text"] + " corrected"
        editor["document"]["words"][0]["text"] = changed_text
        saved = client.put(editor_path, json={
            "expectedRevision": editor["revision"], "document": editor["document"],
        })
        assert saved.status_code == 200, saved.text
        assert saved.json()["revision"] > take["songRevision"]
        assert client.get(editor_path).json()["document"]["words"][0]["text"] == changed_text
        service = client.app.state.container.recordings.start_analysis
        reference = service._projects.artifact_path(song["songId"], take["songRevision"], "referenceVocal")
        observed = []
        original_extract = service._pitch.extract_vocals

        def extract(recorded, expected, *args, **kwargs):
            observed.append(expected)
            return original_extract(recorded, expected, *args, **kwargs)

        monkeypatch.setattr(service._pitch, "extract_vocals", extract)
        result = _analyze(client, take["recordingId"])
        assert observed == [reference]
        assert result["state"] == "Succeeded", result
        assert result["songRevision"] == take["songRevision"]
        current = client.get(f"/recordings/{take['recordingId']}").json()
        assert current["songRevision"] == take["songRevision"]
        assert current["analysisStatus"] == "Succeeded"
        results = client.get(f"/recordings/{take['recordingId']}/analyses").json()
        assert {item["analysisId"] for item in results} == {first["analysisId"], result["analysisId"]}
        assert all(item["state"] == "Succeeded" for item in results)


@pytest.mark.parametrize(
    "case, expected",
    [
        ("historical", AnalysisState.SUCCEEDED),
        ("master-with-deleted-source", AnalysisState.SUCCEEDED),
        ("wrong-revision", AnalysisState.STALE),
        ("wrong-song", AnalysisState.STALE),
        ("old-algorithm", AnalysisState.STALE),
        ("missing-song", AnalysisState.STALE),
        ("missing-recording", AnalysisState.STALE),
    ],
)
def test_analysis_validity_uses_its_own_recorded_song_reference(case, expected):
    now = datetime.now(UTC)
    take = Recording("take", Path("recording.wav"), 1, 16000, 1, now, "song", 2)
    result = AnalysisResult(
        "analysis", "take", "song", 2, ANALYSIS_ALGORITHM_VERSION,
        AnalysisState.SUCCEEDED, now, now, "recording-hash",
    )
    song = SimpleNamespace(active_revision=3)
    if case == "master-with-deleted-source":
        take = replace(take, session_metadata={"studioMaster": {"sourceRecordingId": "deleted"}})
    elif case == "wrong-revision":
        result = replace(result, song_revision=3)
    elif case == "wrong-song":
        result = replace(result, song_id="other-song", song_revision=3)
    elif case == "old-algorithm":
        result = replace(result, algorithm_version="obsolete")
    elif case == "missing-song":
        song = None
    elif case == "missing-recording":
        take = None
        result = replace(result, song_revision=3)

    @contextmanager
    def transaction():
        yield SimpleNamespace(
            recordings=SimpleNamespace(get=lambda _: take),
            analyses=SimpleNamespace(list_for_recording=lambda _: [result]),
            songs=SimpleNamespace(get=lambda _: song),
        )

    returned = ListRecordingAnalyses(SimpleNamespace(create=transaction)).execute("take")
    assert returned[0].state is expected
    assert result.state is AnalysisState.SUCCEEDED, "querying must not rewrite historical rows"
