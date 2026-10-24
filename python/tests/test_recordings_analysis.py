from __future__ import annotations

import pytest
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
import threading

from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.helpers import import_song, wait_for_job


pytestmark = pytest.mark.integration


def ready_song(client, source: Path) -> dict[str, object]:
    song = import_song(client, source)
    started = client.post(
        f"/songs/{song['songId']}/processing",
        json={"mode": "Fast", "onlineLyrics": False},
    )
    job = wait_for_job(client, started.json()["jobId"])
    assert job["state"] == "Succeeded", job
    return client.get(f"/songs/{song['songId']}").json()


def register_recording(
    client,
    song: dict[str, object],
    *,
    frequency: float = 440.0,
    session_metadata: dict[str, object] | None = None,
    idempotency_key: str = "recording-register",
) -> dict[str, object]:
    target = client.post("/recordings/target")
    assert target.status_code == 200, target.text
    payload = target.json()
    path = Path(payload["filePath"])
    write_wav(path, frequency=frequency)
    response = client.post(
        "/recordings",
        json={
            "recordingId": payload["recordingId"],
            "filePath": str(path),
            "duration": 1.0,
            "sampleRate": 16_000,
            "channels": 1,
            "createdAt": datetime.now(UTC).isoformat(),
            "songId": song["songId"],
            "songRevision": song["activeRevision"],
            "gaps": [],
            "sessionMetadata": session_metadata or {"session": "test"},
        },
        headers={"Idempotency-Key": idempotency_key},
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_recording_registration_is_idempotent_and_paginated(tmp_path: Path) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song = ready_song(client, source)
        recording = register_recording(client, song)

        fetched = client.get(f"/recordings/{recording['recordingId']}")
        page = client.get(
            "/recordings", params={"song_id": song["songId"], "limit": 1, "offset": 0}
        )

        assert fetched.status_code == 200
        assert page.status_code == 200
        assert page.json()["total"] == 1
        assert page.json()["items"][0]["recordingId"] == recording["recordingId"]


def test_completed_live_analysis_is_available_without_any_ai_work(
    tmp_path: Path, monkeypatch
) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song = ready_song(client, source)
        monkeypatch.setattr(
            FakeAiProvider, "pitch", lambda *a, **kw: pytest.fail("Unexpected pitch pass")
        )
        monkeypatch.setattr(
            FakeAiProvider, "separate", lambda *a, **kw: pytest.fail("Unexpected separation")
        )
        recording = register_recording(
            client,
            song,
            session_metadata={
                "karaokeNoteScore": {
                    "version": 3,
                    "expectedPitchSeconds": 10,
                    "assessedPitchSeconds": 10,
                    "hitNotes": 3,
                    "totalNotes": 5,
                    "pitchAccuracyPercent": 61.25,
                    "meanSemitoneDeviation": 0.42,
                    "rhythmAccuracyPercent": 72,
                    "noteStabilityPercent": 88,
                }
            },
        )
        results = client.get(f"/recordings/{recording['recordingId']}/analyses").json()
        assert len(results) == 1
        assert results[0]["state"] == "Succeeded"
        assert results[0]["pitchAccuracyPercent"] == 61.25
        assert results[0]["rhythmAccuracyPercent"] == 72
        assert results[0]["noteStabilityPercent"] == 88
        assert (
            client.get(f"/recordings/{recording['recordingId']}").json()["analysisStatus"]
            == "Succeeded"
        )
        started = client.post(f"/recordings/{recording['recordingId']}/analysis")
        job = wait_for_job(client, started.json()["jobId"])
        assert job["state"] == "Succeeded", job
        repeated = client.get(f"/recordings/{recording['recordingId']}/analyses").json()
        assert all(item["pitchAccuracyPercent"] == 61.25 for item in repeated)


def test_uncertain_live_pitch_is_not_reported_as_bad_singing(tmp_path: Path) -> None:
    source = tmp_path / "uncertain.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        recording = register_recording(
            client,
            ready_song(client, source),
            session_metadata={
                "karaokeNoteScore": {
                    "version": 3,
                    "hitNotes": 0,
                    "totalNotes": 0,
                    "expectedPitchSeconds": 10,
                    "assessedPitchSeconds": 0,
                    "pitchAccuracyPercent": 0,
                    "meanSemitoneDeviation": 0,
                    "rhythmAccuracyPercent": 100,
                    "noteStabilityPercent": 0,
                }
            },
        )
        results = client.get(f"/recordings/{recording['recordingId']}/analyses").json()
        assert len(results) == 1
        assert results[0]["state"] == "Failed"
        assert results[0]["error"]["code"] == "AnalysisPitchUncertain"


@pytest.mark.parametrize(
    "changes",
    [
        {"version": 0},
        {"version": 1},
        {"version": 2},
        {"assessedPitchSeconds": 11},
        {"pitchAccuracyPercent": 101},
        {"meanSemitoneDeviation": -1},
        {"totalNotes": 0},
    ],
)
def test_incomplete_or_invalid_live_analysis_is_not_presented_as_a_result(
    tmp_path: Path, changes
) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        score = {
            "version": 3,
            "expectedPitchSeconds": 10,
            "assessedPitchSeconds": 10,
            "hitNotes": 3,
            "totalNotes": 5,
            "pitchAccuracyPercent": 61,
            "meanSemitoneDeviation": 0.4,
            "rhythmAccuracyPercent": 72,
            "noteStabilityPercent": 88,
            **changes,
        }
        recording = register_recording(
            client, ready_song(client, source), session_metadata={"karaokeNoteScore": score}
        )
        assert client.get(f"/recordings/{recording['recordingId']}/analyses").json() == []


def test_recording_rejects_metadata_mismatch(tmp_path: Path) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song = ready_song(client, source)
        target = client.post("/recordings/target").json()
        path = Path(target["filePath"])
        write_wav(path)

        response = client.post(
            "/recordings",
            json={
                "recordingId": target["recordingId"],
                "filePath": str(path),
                "duration": 1.0,
                "sampleRate": 48_000,
                "channels": 1,
                "createdAt": datetime.now(UTC).isoformat(),
                "songId": song["songId"],
                "songRevision": song["activeRevision"],
            },
        )

        assert response.status_code == 400
        assert response.json()["code"] == "InvalidRecording"


def test_offline_analysis_succeeds_and_becomes_stale_after_project_revision(tmp_path: Path) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song = ready_song(client, source)
        recording = register_recording(client, song)
        started = client.post(f"/recordings/{recording['recordingId']}/analysis")
        assert started.status_code == 202, started.text
        job = wait_for_job(client, started.json()["jobId"])
        assert job["state"] == "Succeeded", job
        analyses = client.get(f"/recordings/{recording['recordingId']}/analyses").json()
        assert analyses[0]["state"] == "Succeeded"
        analysis_id = analyses[0]["analysisId"]
        assert analyses[0]["pitchAccuracyPercent"] is not None

        editor = client.get(f"/songs/{song['songId']}/editor").json()
        saved = client.put(
            f"/songs/{song['songId']}/editor",
            json={"expectedRevision": editor["revision"], "document": editor["document"]},
        )
        assert saved.status_code == 200, saved.text
        # The list the app reads marks an analysis of an older revision as Stale (spec 132).
        stale = client.get(f"/recordings/{recording['recordingId']}/analyses").json()

        assert next(item for item in stale if item["analysisId"] == analysis_id)["state"] == "Stale"


def test_analysis_uses_separated_vocal_and_reference_pitch_instead_of_live_ui_scores(
    tmp_path: Path,
) -> None:
    class ObservedProvider(FakeAiProvider):
        def __init__(self):
            super().__init__()
            self.separated_inputs = []
            self.pitched_inputs = []

        def separate(self, audio, workdir, cancel, *, execution):
            self.separated_inputs.append(audio)
            return super().separate(audio, workdir, cancel, execution=execution)

        def pitch(self, vocal, cancel, *, execution):
            self.pitched_inputs.append(vocal)
            return super().pitch(vocal, cancel, execution=execution)

    provider = ObservedProvider()
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(provider,)) as client:
        song = ready_song(client, source)
        recording = register_recording(
            client,
            song,
            session_metadata={
                "karaokeNoteScore": {
                    "hitNotes": 0,
                    "totalNotes": 100,
                    "rhythmAccuracyPercent": 3,
                    "noteStabilityPercent": 2,
                }
            },
        )
        started = client.post(f"/recordings/{recording['recordingId']}/analysis")
        job = wait_for_job(client, started.json()["jobId"])
        assert job["state"] == "Succeeded", job
        result = client.get(f"/recordings/{recording['recordingId']}/analyses").json()[0]
        assert Path(recording["filePath"]) in provider.separated_inputs
        assert len(provider.pitched_inputs) == 3  # Processing, recorded vocal, original vocal.
        for key in ("pitchAccuracyPercent", "rhythmAccuracyPercent", "noteStabilityPercent"):
            assert result[key] == pytest.approx(100)


def test_old_analysis_algorithm_is_stale_without_deleting_its_history(tmp_path: Path) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        recording = register_recording(client, ready_song(client, source))
        started = client.post(f"/recordings/{recording['recordingId']}/analysis")
        assert wait_for_job(client, started.json()["jobId"])["state"] == "Succeeded"
        database = client.app.state.container.database
        with database.create() as transaction:
            result = transaction.analyses.list_for_recording(recording["recordingId"])[0]
            transaction.analyses.update(replace(result, algorithm_version="obsolete"))
            transaction.commit()
        results = client.get(f"/recordings/{recording['recordingId']}/analyses").json()
        assert len(results) == 1
        assert results[0]["analysisId"] == result.analysis_id
        assert results[0]["state"] == "Stale"


def test_repeated_analysis_requests_share_the_running_job(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    entered, release = threading.Event(), threading.Event()
    original_pitch = FakeAiProvider.pitch
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        recording = register_recording(client, ready_song(client, source))

        def blocked_pitch(self, path, cancel, *, execution):
            entered.set()
            assert release.wait(3)
            return original_pitch(self, path, cancel, execution=execution)

        monkeypatch.setattr(FakeAiProvider, "pitch", blocked_pitch)
        first = client.post(f"/recordings/{recording['recordingId']}/analysis").json()
        try:
            assert entered.wait(3)
            second = client.post(f"/recordings/{recording['recordingId']}/analysis").json()
            assert second["jobId"] == first["jobId"]
            assert len(client.get(f"/recordings/{recording['recordingId']}/analyses").json()) == 1
        finally:
            release.set()
        assert wait_for_job(client, first["jobId"])["state"] == "Succeeded"
        later = client.post(f"/recordings/{recording['recordingId']}/analysis").json()
        assert later["jobId"] != first["jobId"]
        assert wait_for_job(client, later["jobId"])["state"] == "Succeeded"


def test_different_recordings_wait_for_analysis_resources_and_can_cancel_queue(
    tmp_path: Path, monkeypatch
) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    entered, release = threading.Event(), threading.Event()
    original_pitch = FakeAiProvider.pitch
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song = ready_song(client, source)
        takes = [
            register_recording(client, song, idempotency_key=f"take-{index}") for index in range(3)
        ]

        def blocked_pitch(self, path, cancel, *, execution):
            entered.set()
            assert release.wait(5)
            return original_pitch(self, path, cancel, execution=execution)

        monkeypatch.setattr(FakeAiProvider, "pitch", blocked_pitch)
        first = client.post(f"/recordings/{takes[0]['recordingId']}/analysis").json()
        try:
            assert entered.wait(3)
            second = client.post(f"/recordings/{takes[1]['recordingId']}/analysis").json()
            cancelled = client.post(f"/recordings/{takes[2]['recordingId']}/analysis").json()
            threading.Event().wait(0.15)
            assert client.get(f"/jobs/{second['jobId']}").json()["state"] == "Queued"
            assert client.post(f"/jobs/{cancelled['jobId']}/cancel").status_code == 200
        finally:
            release.set()
        assert wait_for_job(client, first["jobId"])["state"] == "Succeeded"
        assert wait_for_job(client, second["jobId"])["state"] == "Succeeded"
        assert wait_for_job(client, cancelled["jobId"])["state"] == "Cancelled"


def test_analysis_waits_while_song_processing_owns_the_shared_compute_budget(
    tmp_path: Path, monkeypatch
) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    entered, release = threading.Event(), threading.Event()
    original = FakeAiProvider.separate
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song = ready_song(client, source)
        take = register_recording(client, song)

        def blocked(self, *args, **kwargs):
            entered.set()
            assert release.wait(5)
            return original(self, *args, **kwargs)

        monkeypatch.setattr(FakeAiProvider, "separate", blocked)
        processing = client.post(
            f"/songs/{song['songId']}/processing", json={"mode": "Fast", "onlineLyrics": False}
        ).json()
        try:
            assert entered.wait(3)
            analysis = client.post(f"/recordings/{take['recordingId']}/analysis").json()
            threading.Event().wait(0.15)
            assert client.get(f"/jobs/{analysis['jobId']}").json()["state"] == "Queued"
        finally:
            release.set()
        assert wait_for_job(client, processing["jobId"])["state"] == "Succeeded"
        assert wait_for_job(client, analysis["jobId"])["state"] == "Succeeded"


@pytest.mark.parametrize(
    "capture_kind, delay",
    [("copy", 0.12), ("early", -0.08), ("other_voice", 0), ("ambiguous_tone", 0)],
)
def test_analysis_compensates_only_repeated_unambiguous_audio_delay(
    tmp_path: Path,
    capture_kind: str,
    delay: float,
) -> None:
    import numpy as np
    import soundfile as sf
    from scipy import signal

    rate, seconds = 16_000, 20
    rng = np.random.default_rng(7)
    original = signal.sosfiltfilt(
        signal.butter(3, [100, 1800], fs=rate, btype="bandpass", output="sos"),
        rng.normal(0, 0.1, rate * seconds),
    )
    if capture_kind == "ambiguous_tone":
        original = 0.1 * np.sin(2 * np.pi * 440 * np.arange(rate * seconds) / rate)
    captured = (
        rng.normal(0, 0.02, len(original))
        if capture_kind == "other_voice"
        else np.roll(original, round(delay * rate)) * -0.3
    )
    reference, recording = tmp_path / "reference.wav", tmp_path / "capture.wav"
    sf.write(reference, original, rate, subtype="PCM_24")
    sf.write(recording, signal.resample_poly(captured, 3, 1), rate * 3, subtype="PCM_16")
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        extractor = client.app.state.container.recordings.start_analysis._pitch
        actual, expected = extractor.extract_vocals(
            recording, reference, threading.Event(), lambda *args: None
        )
    assert actual[0].time == pytest.approx(expected[0].time - delay, abs=0.001)


def test_delete_recording_removes_owned_file_and_metadata(tmp_path: Path) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song = ready_song(client, source)
        recording = register_recording(client, song)
        path = Path(recording["filePath"])
        assert path.is_file()

        response = client.delete(f"/recordings/{recording['recordingId']}")

        assert response.status_code == 204
        assert not path.exists()
        assert client.get(f"/recordings/{recording['recordingId']}").status_code == 404


def test_recording_name_and_status_are_backend_authoritative(tmp_path: Path) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song = ready_song(client, source)
        recording = register_recording(client, song)

        renamed = client.patch(
            f"/recordings/{recording['recordingId']}", json={"displayName": "My best take"}
        )

        assert renamed.status_code == 200, renamed.text
        assert renamed.json()["displayName"] == "My best take"
        assert renamed.json()["fileStatus"] == "Ready"
        assert renamed.json()["analysisStatus"] == "NotAnalyzed"


def test_studio_master_creates_a_separate_adaptively_balanced_recording(
    tmp_path: Path,
) -> None:
    source = tmp_path / "song.wav"
    write_wav(source, frequency=220.0)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song = ready_song(client, source)
        recording = register_recording(client, song, frequency=440.0)

        started = client.post(f"/recordings/{recording['recordingId']}/studio-master")

        assert started.status_code == 202, started.text
        job = wait_for_job(client, started.json()["jobId"], timeout=30)
        assert job["state"] == "Succeeded", job
        master_id = job["report"]["recordingId"]
        master = client.get(f"/recordings/{master_id}")
        originals = client.get(
            "/recordings", params={"song_id": song["songId"], "limit": 10}
        ).json()["items"]

        assert master.status_code == 200, master.text
        assert master.json()["recordingId"] != recording["recordingId"]
        assert master.json()["sourceRecordingId"] == recording["recordingId"]
        # The interface names a master in its own language from its source take.
        assert master.json()["displayName"] is None
        assert Path(master.json()["filePath"]).is_file()
        assert len(originals) == 2
        assert job["report"]["balance"]["vocalGainDb"] is not None


@pytest.mark.parametrize("property_name", ["balance", "effects", "duration"])
def test_studio_master_keeps_the_recorded_balance_wet_effects_and_take_duration(
    tmp_path: Path,
    property_name: str,
) -> None:
    import numpy as np
    import soundfile as sf
    from backend.ai.domain import SeparatedAudio

    rate = 16_000
    time = np.arange(rate) / rate
    dry = 0.04 * np.sin(2 * np.pi * 440 * time) * (time < 0.3)
    echo = 0.024 * np.sin(2 * np.pi * 440 * time) * ((time >= 0.65) & (time < 0.95))
    backing = 0.02 * np.sin(2 * np.pi * 220 * time)

    class SeparationThatDropsEcho(FakeAiProvider):
        def separate(self, audio, workdir, cancel, *, execution):
            workdir.mkdir(parents=True, exist_ok=True)
            vocal_path, backing_path = workdir / "voice.wav", workdir / "backing.wav"
            if audio.name == "recording.wav":
                voice, music = dry, backing
            else:
                source_time = np.arange(rate * 2) / rate
                voice = 0.1 * np.sin(2 * np.pi * 440 * source_time)
                music = 0.3 * np.sin(2 * np.pi * 220 * source_time)
            sf.write(vocal_path, voice, rate)
            sf.write(backing_path, music, rate)
            return SeparatedAudio(backing_path, vocal_path)

    source = tmp_path / "song.wav"
    write_wav(source, seconds=2.0, frequency=220.0)
    with app_client(tmp_path / "runtime", ai_providers=(SeparationThatDropsEcho(),)) as client:
        song = ready_song(client, source)
        recording = register_recording(client, song)
        sf.write(recording["filePath"], dry + echo + backing, rate)
        started = client.post(f"/recordings/{recording['recordingId']}/studio-master")
        job = wait_for_job(client, started.json()["jobId"], timeout=30)
        assert job["state"] == "Succeeded", job
        master = client.get(f"/recordings/{job['report']['recordingId']}").json()
        samples, output_rate = sf.read(master["filePath"], always_2d=True)
        samples = samples.mean(axis=1)

    def amplitude(frequency, start, end):
        clip = samples[round(start * output_rate) : round(end * output_rate)]
        axis = np.arange(len(clip)) / output_rate
        return 2 * abs(np.mean(clip * np.exp(-2j * np.pi * frequency * axis)))

    voice = amplitude(440, 0.05, 0.25)
    actual, expected, tolerance = {
        "balance": (20 * np.log10(voice / amplitude(220, 0.05, 0.25)), 20 * np.log10(2), 0.8),
        "effects": (amplitude(440, 0.7, 0.9) / voice, 0.6, 0.05),
        "duration": (len(samples) / output_rate, 1.0, 1 / output_rate),
    }[property_name]
    assert actual == pytest.approx(expected, abs=tolerance)
