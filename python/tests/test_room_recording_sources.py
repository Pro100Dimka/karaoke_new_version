import json
import shutil
import threading
import zipfile
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from backend.domain_errors import DomainError
from backend.recordings.domain import Recording
from backend.recordings.room_sources import (
    complete_room_sources,
    export_room_source,
    import_room_source,
    initialize_room_sources,
    room_source_state,
)
from tests.conftest import app_client


@pytest.fixture
def take(tmp_path):
    root = tmp_path / "take"
    root.mkdir()
    rate = 44100
    time = np.arange(rate * 2) / rate
    voice = np.repeat((0.05 * np.sin(2 * np.pi * 330 * time))[:, None], 2, axis=1).astype("float32")
    path = root / "recording.wav"
    sf.write(path, voice + 0.1, rate, subtype="FLOAT")
    sf.write(Path(str(path) + ".dry-incomplete.wav"), voice, rate, subtype="FLOAT")
    Path(str(path) + ".timeline.csv").write_text(
        "wavOffsetFrames,timelineFrame,frames,sampleRateHz,roomClockValid,captureTimelineFrame,captureEndTimelineFrame,timelineSampleRateHz\n"
        f"0,48000,{rate},{rate},1,0,0,48000\n{rate},144000,{rate},{rate},1,0,0,48000\n"
    )
    recording = Recording(
        "take",
        path,
        2,
        rate,
        2,
        datetime.now(UTC),
        session_metadata={
            "roomPerformance": {
                "roomId": "2f81a558-8d2f-461e-ac70-9420a8c3d45e",
                "performanceId": 7,
            }
        },
    )
    return recording, voice


def test_room_source_roundtrip_keeps_only_its_own_lossless_voice_and_timeline(take):
    recording, expected = take
    bundle = export_room_source(recording, "singer")
    imported = import_room_source(recording, "singer", bundle)
    actual, rate = sf.read(imported / "voice.wav", dtype="float32", always_2d=True)
    assert rate == recording.sample_rate
    np.testing.assert_array_equal(actual, expected)
    assert (imported / "timeline.csv").read_bytes() == Path(
        str(recording.file_path) + ".timeline.csv"
    ).read_bytes()
    assert json.loads((imported / "metadata.json").read_text())["participantId"] == "singer"


@pytest.mark.parametrize("change", ["singer", "performance", "room", "path", "duplicates"])
def test_import_rejects_foreign_or_ambiguous_room_sources(take, change):
    recording, _ = take
    original = export_room_source(recording, "singer")
    target = original.with_name("invalid.zip")
    with zipfile.ZipFile(original) as source:
        files = {name: source.read(name) for name in source.namelist()}
    metadata = json.loads(files["metadata.json"])
    if change in ["singer", "performance", "room"]:
        field, value = {
            "singer": ("participantId", "other"),
            "performance": ("performanceId", 8),
            "room": ("roomId", "other-room"),
        }[change]
        metadata[field] = value
        files["metadata.json"] = json.dumps(metadata).encode()
    with zipfile.ZipFile(target, "w") as archive:
        for name, content in files.items():
            archive.writestr(
                "../voice.wav" if change == "path" and name == "voice.wav" else name, content
            )
        if change == "duplicates":
            archive.writestr("metadata.json", files["metadata.json"])
    with pytest.raises(DomainError):
        import_room_source(recording, "singer", target)
    assert not (recording.file_path.parent.parent / "voice.wav").exists()


def test_room_source_api_keeps_master_inputs_pending_until_every_source_is_registered(
    take, tmp_path
):
    recording, _ = take
    with app_client(tmp_path / "runtime") as client:
        target = client.post("/recordings/target").json()
        path = Path(target["filePath"])
        for suffix in ("", ".dry-incomplete.wav", ".timeline.csv"):
            shutil.copyfile(Path(str(recording.file_path) + suffix), Path(str(path) + suffix))
        registered = client.post(
            "/recordings",
            json={
                **target,
                "duration": recording.duration,
                "sampleRate": recording.sample_rate,
                "channels": recording.channels,
                "createdAt": recording.created_at.isoformat(),
                "sessionMetadata": recording.session_metadata,
            },
        )
        assert registered.status_code == 201, registered.text
        assert registered.json()["roomSources"]["status"] == "pending"
        base = f"/recordings/{target['recordingId']}"
        exported = client.post(f"{base}/room-source", json={"participantId": "singer"})
        assert exported.status_code == 200, exported.text
        imported = client.post(
            f"{base}/room-source/import",
            json={
                "participantId": "singer",
                "filePath": exported.json()["filePath"],
            },
        )
        assert imported.status_code == 200, imported.text
        completed = client.post(
            f"{base}/room-sources",
            json={
                "participants": {"singer": [imported.json()["directory"]], "silent": None},
            },
        )
        assert completed.status_code == 200, completed.text
        assert completed.json()["status"] == "ready"
        assert client.get(base).json()["roomSources"] == completed.json()


def test_missing_import_never_turns_pending_room_sources_into_a_ready_master(take):
    recording, _ = take
    initialize_room_sources(recording)
    with pytest.raises(DomainError):
        complete_room_sources(recording, {"singer": ["missing-directory"]})
    assert room_source_state(recording)["status"] == "pending"


def test_deleted_import_is_not_accepted_from_the_archive_cache(take):
    recording, _ = take
    bundle = export_room_source(recording, "singer")
    imported = import_room_source(recording, "singer", bundle)
    (imported / "voice.wav").unlink()
    with pytest.raises(DomainError):
        import_room_source(recording, "singer", bundle)
    with pytest.raises(DomainError):
        complete_room_sources(recording, {"singer": [imported.name]})


def test_reconnected_captures_keep_early_voice_and_replace_overlaps_without_doubling(tmp_path):
    from backend.infrastructure.process_runner import ProcessRunner
    from backend.recordings.room_source_alignment import align_room_captures
    from backend.recordings.studio_master import FfmpegStudioMasterRenderer

    rate = 48000
    header = (
        "wavOffsetFrames,timelineFrame,frames,sampleRateHz,roomClockValid,timelineSampleRateHz\n"
    )
    timeline = tmp_path / "recipient.csv"
    timeline.write_text(header + f"0,480000,{rate * 3},{rate},1,48000\n")
    sources = []
    for index, (source_rate, start, seconds, level) in enumerate(
        [(44100, 10, 2.5, 0.1), (48000, 12, 1, 0.2)]
    ):
        source = tmp_path / str(index)
        source.mkdir()
        frames = round(seconds * source_rate)
        sf.write(source / "voice.wav", np.full(frames, level), source_rate, subtype="FLOAT")
        (source / "timeline.csv").write_text(
            header + f"0,{start * 48000},{frames},{source_rate},1,48000\n"
        )
        sources.append(source)
    target = tmp_path / "aligned.wav"
    align_room_captures(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        list(reversed(sources)),
        timeline,
        target,
        threading.Event(),
        frames=rate * 3,
        rate=rate,
        channels=2,
    )
    actual, _ = sf.read(target, always_2d=True)
    np.testing.assert_allclose(actual[rate // 10 : rate * 2 - rate // 10], 0.1, atol=1e-5)
    np.testing.assert_allclose(
        actual[rate * 2 + rate // 10 : rate * 3 - rate // 10], 0.2, atol=1e-5
    )


@pytest.mark.parametrize(
    "source_rate,target_rate", [(44100, 48000), (48000, 44100), (44100, 44100), (48000, 48000)]
)
@pytest.mark.parametrize("drift", [0, 0.00015])
def test_singer_clock_alignment_preserves_attacks_across_pause_and_late_join(
    tmp_path, source_rate, target_rate, drift
):
    from backend.infrastructure.process_runner import ProcessRunner
    from backend.recordings.room_source_alignment import align_room_source
    from backend.recordings.studio_master import FfmpegStudioMasterRenderer

    def timeline(name, rate, intervals, clock_scale):
        path = tmp_path / f"{name}.csv"
        rows = [
            "wavOffsetFrames,timelineFrame,frames,sampleRateHz,roomClockValid,timelineSampleRateHz"
        ]
        audio = []
        offset = 0
        for start, duration in intervals:
            count = round(duration * rate / clock_scale)
            positions = start + np.arange(count) / rate * clock_scale
            samples = sum(
                0.1 * np.exp(-(((positions - attack) / 0.002) ** 2)) for attack in (10.3, 12.3)
            )
            audio.append(samples)
            for frame in range(0, count, 512):
                rows.append(
                    f"{offset + frame},{round((start + frame / rate * clock_scale) * 48000)},{min(512, count - frame)},{rate},1,48000"
                )
            offset += count
        path.write_text("\n".join(rows) + "\n")
        return path, np.concatenate(audio)

    source_csv, samples = timeline("singer", source_rate, [(9.75, 1.25), (11.75, 1.25)], 1 + drift)
    recipient_csv, recipient = timeline("recipient", target_rate, [(10, 1), (12, 1)], 1)
    source = tmp_path / "voice.wav"
    sf.write(source, np.repeat(samples[:, None], 2, axis=1), source_rate, subtype="FLOAT")
    target = tmp_path / "aligned.wav"
    align_room_source(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        source,
        source_csv,
        recipient_csv,
        target,
        threading.Event(),
        frames=len(recipient),
        rate=target_rate,
        channels=2,
    )
    actual, rate = sf.read(target, always_2d=True)
    assert (len(actual), rate, actual.shape[1]) == (len(recipient), target_rate, 2)
    np.testing.assert_array_equal(actual[:, 0], actual[:, 1])
    for expected in (0.3, 1.3):
        start, end = round((expected - 0.03) * rate), round((expected + 0.03) * rate)
        attack = (start + np.argmax(actual[start:end, 0])) / rate
        assert abs(attack - expected) <= 0.001
        assert actual[start:end, 0].max() > 0.09
    assert np.max(np.abs(actual[: round(0.25 * rate)])) < 1e-5


def test_singer_clock_alignment_compensates_drift_without_moving_late_attacks(tmp_path):
    from backend.infrastructure.process_runner import ProcessRunner
    from backend.recordings.room_source_alignment import align_room_source
    from backend.recordings.studio_master import FfmpegStudioMasterRenderer

    rate, seconds, scale = 44100, 60, 1.00015
    frames = rate * seconds
    time = np.arange(frames) / rate
    samples = 0.1 * np.exp(-(((time * scale - 59.3) / 0.002) ** 2))
    source = tmp_path / "voice.wav"
    sf.write(source, samples, rate, subtype="FLOAT")
    paths = []
    for name, clock_scale in [("singer", scale), ("recipient", 1)]:
        path = tmp_path / f"{name}.csv"
        rows = [
            "wavOffsetFrames,timelineFrame,frames,sampleRateHz,roomClockValid,timelineSampleRateHz"
        ]
        for offset in range(0, frames, 512):
            rows.append(
                f"{offset},{round((10 + offset / rate * clock_scale) * 48000)},{min(512, frames - offset)},{rate},1,48000"
            )
        path.write_text("\n".join(rows) + "\n")
        paths.append(path)
    target = tmp_path / "aligned.wav"
    align_room_source(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        source,
        *paths,
        target,
        threading.Event(),
        frames=frames,
        rate=rate,
        channels=6,
    )
    actual, _ = sf.read(target, always_2d=True)
    assert actual.shape == (frames, 6)
    assert abs(np.argmax(actual[:, 0]) / rate - 59.3) < 0.001
    np.testing.assert_array_equal(actual, np.repeat(actual[:, :1], 6, axis=1))


def test_singer_clock_alignment_leaves_missing_intervals_silent(tmp_path):
    from backend.infrastructure.process_runner import ProcessRunner
    from backend.recordings.room_source_alignment import align_room_source
    from backend.recordings.studio_master import FfmpegStudioMasterRenderer

    rate = 48000
    source = tmp_path / "voice.wav"
    sf.write(source, np.ones(rate) * 0.1, rate, subtype="FLOAT")
    header = (
        "wavOffsetFrames,timelineFrame,frames,sampleRateHz,roomClockValid,timelineSampleRateHz\n"
    )
    source_csv, recipient_csv = tmp_path / "source.csv", tmp_path / "recipient.csv"
    source_csv.write_text(
        header
        + f"0,504000,{rate // 2},{rate},1,48000\n{rate // 2},552000,{rate // 2},{rate},1,48000\n"
    )
    recipient_csv.write_text(header + f"0,480000,{rate * 3},{rate},1,48000\n")
    target = tmp_path / "aligned.wav"
    align_room_source(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        source,
        source_csv,
        recipient_csv,
        target,
        threading.Event(),
        frames=rate * 3,
        rate=rate,
        channels=2,
    )
    actual, _ = sf.read(target, always_2d=True)
    for start, end in [(0.01, 0.49), (1.01, 1.49), (2.01, 2.99)]:
        assert np.max(np.abs(actual[round(start * rate) : round(end * rate)])) < 1e-5
    for start, end in [(0.51, 0.99), (1.51, 1.99)]:
        np.testing.assert_allclose(actual[round(start * rate) : round(end * rate)], 0.1, atol=1e-5)
