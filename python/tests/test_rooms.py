from __future__ import annotations

import pytest
from dataclasses import replace
from datetime import datetime, timedelta
from backend.bootstrap.room_wiring import build_room_cases
from backend.infrastructure.ids import UuidGenerator
from backend.infrastructure.in_memory_rooms import InMemoryRoomRepository
from backend.infrastructure.sqlite_rooms import SqliteRoomRepository
from backend.room.commands import MediaControlCommand
from backend.room.membership_commands import (
    CreateRoom,
    DisconnectParticipant,
    JoinRoom,
    ResolveHostDisconnect,
)
from backend.room.domain import HostDisconnectPolicy, PlaybackState
from backend.room.serialization import RoomLocks
from tests.fakes import FakeClock


pytestmark = pytest.mark.integration


def _measure_voice_routes(client, room_id: str, *participant_ids: str) -> None:
    for index, participant_id in enumerate(participant_ids):
        response = client.post(
            f"/rooms/{room_id}/timing",
            json={"participantId": participant_id, "voiceLatencyMs": 30 + index * 2.5},
        )
        assert response.status_code == 200, response.text


def test_room_uses_a_safe_conversation_deadline_before_voice_is_measured() -> None:
    cases = build_room_cases(UuidGenerator(), FakeClock(), InMemoryRoomRepository())

    room = cases.create.execute("host", "Host", HostDisconnectPolicy.TRANSFER)

    assert room.room_playout_delay_ms == 250


def test_idle_room_covers_measured_routes_even_when_all_exceed_the_singing_limit() -> None:
    rooms = InMemoryRoomRepository()
    cases = build_room_cases(UuidGenerator(), FakeClock(), rooms)
    room = cases.create.execute("host", "Host", HostDisconnectPolicy.TRANSFER)
    joined = cases.join.execute(room.room_id, "guest", "Guest")

    cases.set_timing.execute(joined.room_id, "host", 170)
    measured = cases.set_timing.execute(joined.room_id, "guest", 170)

    assert not measured.participants["host"].voice_eligible
    assert not measured.participants["guest"].voice_eligible
    assert measured.room_playout_delay_ms == 250


def test_idle_room_covers_a_shared_mode_listener_above_the_singing_limit() -> None:
    rooms = InMemoryRoomRepository()
    cases = build_room_cases(UuidGenerator(), FakeClock(), rooms)
    room = cases.create.execute("host", "Host", HostDisconnectPolicy.TRANSFER)
    joined = cases.join.execute(room.room_id, "guest", "Guest")

    cases.set_timing.execute(joined.room_id, "host", 40)
    measured = cases.set_timing.execute(joined.room_id, "guest", 180)

    assert measured.participants["host"].voice_eligible
    assert not measured.participants["guest"].voice_eligible
    assert measured.room_playout_delay_ms == 250


def test_room_keeps_an_interactive_seventy_five_millisecond_route_in_the_live_mix() -> None:
    rooms = InMemoryRoomRepository()
    cases = build_room_cases(UuidGenerator(), FakeClock(), rooms)
    room = cases.create.execute("host", "Host", HostDisconnectPolicy.TRANSFER)
    joined = cases.join.execute(room.room_id, "guest", "Guest")

    cases.set_timing.execute(joined.room_id, "host", 35)
    measured = cases.set_timing.execute(joined.room_id, "guest", 75)

    assert measured.participants["guest"].voice_eligible
    assert measured.room_playout_delay_ms == 250


def test_paused_room_remeasures_conversation_latency() -> None:
    rooms = InMemoryRoomRepository()
    cases = build_room_cases(UuidGenerator(), FakeClock(), rooms)
    room = cases.create.execute("host", "Host", HostDisconnectPolicy.TRANSFER)
    measured = cases.set_timing.execute(room.room_id, "host", 44)
    rooms.save(replace(measured, playback_state=PlaybackState.PAUSED))

    unchanged = cases.set_timing.execute(room.room_id, "host", 150)

    assert unchanged.participants["host"].voice_latency_ms == 150
    assert unchanged.room_playout_delay_ms == 250
    assert unchanged.room_return_reserve_ms == measured.room_return_reserve_ms
    assert unchanged.playback_state is PlaybackState.PAUSED


def test_paused_room_uses_conversation_deadline_and_restores_song_deadline(tmp_path) -> None:
    rooms = SqliteRoomRepository(tmp_path / "rooms.db")
    clock = FakeClock()
    cases = build_room_cases(UuidGenerator(), clock, rooms)
    room = cases.create.execute("host", "Host", HostDisconnectPolicy.TRANSFER)
    joined = cases.join.execute(room.room_id, "guest", "Guest")
    cases.set_timing.execute(joined.room_id, "host", 30)
    measured = cases.set_timing.execute(joined.room_id, "guest", 180)
    rooms.save(replace(measured, song_id="song", revision=1))

    playing = cases.authorize_control.execute(room.room_id, "host", MediaControlCommand.START)
    assert playing.room_playout_delay_ms == 30

    paused = cases.authorize_control.execute(room.room_id, "host", MediaControlCommand.PAUSE)
    assert paused.room_playout_delay_ms == 250
    assert paused.playback_state is PlaybackState.PAUSED

    conversation = cases.set_timing.execute(room.room_id, "guest", 145)
    assert conversation.room_playout_delay_ms == 250

    resumed = cases.authorize_control.execute(room.room_id, "host", MediaControlCommand.START)
    assert resumed.room_playout_delay_ms == playing.room_playout_delay_ms
    assert resumed.room_return_reserve_ms == playing.room_return_reserve_ms


def test_join_reopens_measurement_only_while_the_room_is_stopped() -> None:
    rooms = InMemoryRoomRepository()
    cases = build_room_cases(UuidGenerator(), FakeClock(), rooms)
    room = cases.create.execute("host", "Host", HostDisconnectPolicy.TRANSFER)
    measured = cases.set_timing.execute(room.room_id, "host", 32)

    stopped_join = cases.join.execute(room.room_id, "guest", "Guest")
    assert measured.room_playout_delay_ms == 250
    assert stopped_join.room_playout_delay_ms == 250

    finalized = cases.set_timing.execute(room.room_id, "guest", 34)
    rooms.save(replace(finalized, playback_state=PlaybackState.PLAYING))
    playing_join = cases.join.execute(room.room_id, "late", "Late")
    assert playing_join.room_playout_delay_ms == finalized.room_playout_delay_ms


def test_late_joiner_can_publish_timing_without_moving_a_playing_room() -> None:
    rooms = InMemoryRoomRepository()
    clock = FakeClock()
    cases = build_room_cases(UuidGenerator(), clock, rooms)
    room = cases.create.execute("host", "Host", HostDisconnectPolicy.TRANSFER)
    rooms.save(replace(room, song_id="song", revision=1))
    measured = cases.set_timing.execute(
        room.room_id, "host", 35, return_requirement_ms=15, arrival_requirement_ms=18
    )
    playing = replace(
        measured,
        playback_state=PlaybackState.PLAYING,
        playback_started_at=clock.now() - timedelta(seconds=9),
        playback_position_seconds=2.5,
    )
    rooms.save(playing)
    joined = cases.join.execute(room.room_id, "late", "Late")

    updated = cases.set_timing.execute(
        room.room_id, "late", 45, return_requirement_ms=20, arrival_requirement_ms=21
    )

    assert updated.participants["late"].voice_timing_ready
    assert updated.participants["late"].voice_eligible
    assert updated.participants["late"].voice_latency_ms == 45
    assert updated.room_playout_delay_ms == joined.room_playout_delay_ms
    assert updated.room_return_reserve_ms == joined.room_return_reserve_ms
    assert updated.room_timing_source is joined.room_timing_source
    assert updated.playback_state is PlaybackState.PLAYING
    assert updated.playback_started_at == joined.playback_started_at
    assert updated.playback_position_seconds == joined.playback_position_seconds


def test_playing_room_updates_existing_route_eligibility_without_moving_deadline() -> None:
    rooms = InMemoryRoomRepository()
    clock = FakeClock()
    cases = build_room_cases(UuidGenerator(), clock, rooms)
    room = cases.create.execute("host", "Host", HostDisconnectPolicy.TRANSFER)
    rooms.save(replace(room, song_id="song", revision=1))
    measured = cases.set_timing.execute(room.room_id, "host", 175)
    playing = replace(
        measured,
        playback_state=PlaybackState.PLAYING,
        playback_started_at=clock.now() - timedelta(seconds=9),
        playback_position_seconds=2.5,
    )
    rooms.save(playing)
    assert not playing.participants["host"].voice_eligible

    improved = cases.set_timing.execute(room.room_id, "host", 45)
    worsened = cases.set_timing.execute(room.room_id, "host", 180)

    assert improved.participants["host"].voice_eligible
    assert improved.participants["host"].voice_latency_ms == 45
    assert not worsened.participants["host"].voice_eligible
    assert worsened.participants["host"].voice_latency_ms == 180
    for updated in (improved, worsened):
        assert updated.room_playout_delay_ms == playing.room_playout_delay_ms
        assert updated.room_return_reserve_ms == playing.room_return_reserve_ms
        assert updated.playback_state is PlaybackState.PLAYING
        assert updated.playback_started_at == playing.playback_started_at
        assert updated.playback_position_seconds == playing.playback_position_seconds


@pytest.mark.parametrize("rate", [0.5, 1.5])
def test_room_pause_uses_source_time_at_the_selected_tempo(rate: float) -> None:
    rooms = InMemoryRoomRepository()
    clock = FakeClock()
    cases = build_room_cases(UuidGenerator(), clock, rooms)
    room = cases.create.execute("host", "Host", HostDisconnectPolicy.TRANSFER)
    rooms.save(
        replace(
            room,
            playback_state=PlaybackState.PLAYING,
            playback_started_at=clock.now(),
            playback_position_seconds=2,
            playback_rate=rate,
        )
    )
    clock.advance(10)
    paused = cases.authorize_control.execute(room.room_id, "host", MediaControlCommand.PAUSE)
    assert paused.playback_position_seconds == 2 + 10 * rate


@pytest.mark.parametrize("start_delay", [-10, 3])
def test_room_tempo_change_preserves_position_and_pending_start(start_delay: int) -> None:
    rooms = InMemoryRoomRepository()
    clock = FakeClock()
    cases = build_room_cases(UuidGenerator(), clock, rooms)
    room = cases.create.execute("host", "Host", HostDisconnectPolicy.TRANSFER)
    started = clock.now() + timedelta(seconds=start_delay)
    rooms.save(
        replace(
            room,
            playback_state=PlaybackState.PLAYING,
            playback_started_at=started,
            playback_position_seconds=2,
            playback_rate=0.5,
        )
    )
    updated = cases.update_shared_state.execute(
        room.room_id,
        "host",
        radio_enabled=False,
        radio_station_id="groove-salad",
        library_query="",
        library_status="all",
        library_sort="recent",
        playback_rate=1.5,
        key_shift=0,
        music_gain=0.4,
        reference_gain=0.3,
        melody_gain=0.2,
    )
    assert updated.playback_position_seconds == 2 + max(0, -start_delay) * 0.5
    assert updated.playback_started_at == max(started, clock.now())
    clock.advance(4)
    paused = cases.authorize_control.execute(room.room_id, "host", MediaControlCommand.PAUSE)
    assert (
        paused.playback_position_seconds
        == updated.playback_position_seconds + (4 - max(0, start_delay)) * 1.5
    )


def test_host_authority_and_readiness(client) -> None:
    created = client.post(
        "/rooms",
        json={"participantId": "host", "displayName": "Host", "disconnectPolicy": "Transfer"},
    )
    assert created.status_code == 201, created.text
    room_id = created.json()["roomId"]
    joined = client.post(
        f"/rooms/{room_id}/join",
        json={"participantId": "guest", "displayName": "Guest"},
    )
    assert joined.status_code == 200
    _measure_voice_routes(client, room_id, "host", "guest")

    selected = client.post(
        f"/rooms/{room_id}/song",
        json={"participantId": "host", "songId": "song", "revision": 2},
    )
    assert selected.status_code == 200

    not_ready = client.post(
        f"/rooms/{room_id}/control",
        json={"participantId": "host", "command": "Start"},
    )
    assert not_ready.status_code == 409
    assert not_ready.json()["code"] == "RoomNotReady"

    denied = client.post(
        f"/rooms/{room_id}/control",
        json={"participantId": "guest", "command": "Start"},
    )
    assert denied.status_code == 403
    assert denied.json()["code"] == "RoomPermissionDenied"

    ready = client.post(
        f"/rooms/{room_id}/readiness",
        json={"participantId": "guest", "readiness": "Ready"},
    )
    assert ready.status_code == 200
    client.post(
        f"/rooms/{room_id}/readiness",
        json={"participantId": "host", "readiness": "Ready"},
    )
    started = client.post(
        f"/rooms/{room_id}/control",
        json={"participantId": "host", "command": "Start"},
    )
    assert started.status_code == 200
    assert started.json()["songId"] == "song"
    assert started.json()["revision"] == 2
    snapshot = client.get(f"/rooms/{room_id}")
    assert snapshot.status_code == 200
    assert snapshot.json()["playbackState"] == "Playing"
    assert snapshot.json()["playbackStartedAt"] is not None
    assert snapshot.json()["serverNow"] is not None

    stopped = client.post(
        f"/rooms/{room_id}/control",
        json={"participantId": "host", "command": "Stop"},
    )
    assert stopped.status_code == 200
    assert client.get(f"/rooms/{room_id}").json()["playbackState"] == "Stopped"

    denied_exit = client.post(
        f"/rooms/{room_id}/song/clear",
        json={"participantId": "guest"},
    )
    assert denied_exit.status_code == 403

    exited = client.post(
        f"/rooms/{room_id}/song/clear",
        json={"participantId": "host"},
    )
    assert exited.status_code == 200
    assert exited.json()["songId"] is None
    assert exited.json()["revision"] is None
    assert exited.json()["playbackState"] == "Stopped"


def test_selected_song_starts_automatically_only_after_every_participant_is_ready(client) -> None:
    created = client.post("/rooms", json={"participantId": "host", "displayName": "Host"}).json()
    room_id = created["roomId"]
    client.post(
        f"/rooms/{room_id}/join",
        json={"participantId": "guest", "displayName": "Guest"},
    )
    _measure_voice_routes(client, room_id, "host", "guest")
    selected = client.post(
        f"/rooms/{room_id}/song",
        json={"participantId": "host", "songId": "song", "revision": 2},
    ).json()
    assert selected["playbackState"] == "Stopped"

    host_ready = client.post(
        f"/rooms/{room_id}/readiness",
        json={"participantId": "host", "readiness": "Ready"},
    )
    assert host_ready.json()["playbackState"] == "Stopped"

    ready = client.post(
        f"/rooms/{room_id}/readiness",
        json={"participantId": "guest", "readiness": "Ready"},
    )

    assert ready.status_code == 200, ready.text
    assert ready.json()["playbackState"] == "Playing"
    assert ready.json()["playbackStartedAt"] is not None


def test_already_downloaded_room_song_starts_only_after_both_players_are_prepared(client) -> None:
    room_id = client.post("/rooms", json={"participantId": "host", "displayName": "Host"}).json()[
        "roomId"
    ]
    client.post(
        f"/rooms/{room_id}/join",
        json={"participantId": "guest", "displayName": "Guest"},
    )
    _measure_voice_routes(client, room_id, "host", "guest")
    song = {
        "songId": "cached-song",
        "revision": 4,
        "title": "Cached song",
        "artist": "Artist",
        "durationSeconds": 120,
    }
    for participant_id in ("host", "guest"):
        published = client.post(
            f"/rooms/{room_id}/library",
            json={"participantId": participant_id, "songs": [song]},
        )
        assert published.status_code == 200, published.text

    selected = client.post(
        f"/rooms/{room_id}/song",
        json={"participantId": "host", "songId": "cached-song", "revision": 4},
    )

    assert selected.status_code == 200, selected.text
    assert {
        person["participantId"]: person["readinessState"]
        for person in selected.json()["participants"]
    } == {"host": "Preparing", "guest": "Preparing"}
    assert selected.json()["playbackState"] == "Stopped"

    host_ready = client.post(
        f"/rooms/{room_id}/readiness",
        json={"participantId": "host", "readiness": "Ready"},
    ).json()
    assert host_ready["playbackState"] == "Stopped"
    guest_ready = client.post(
        f"/rooms/{room_id}/readiness",
        json={"participantId": "guest", "readiness": "Ready"},
    ).json()
    assert guest_ready["playbackState"] == "Playing"
    assert guest_ready["playbackStartedAt"] is not None


def test_room_transfer_progress_is_authoritative_and_identical_for_every_client(client) -> None:
    room_id = client.post("/rooms", json={"participantId": "host", "displayName": "Host"}).json()[
        "roomId"
    ]
    client.post(
        f"/rooms/{room_id}/join",
        json={"participantId": "guest", "displayName": "Guest"},
    )
    _measure_voice_routes(client, room_id, "host", "guest")
    client.post(
        f"/rooms/{room_id}/song",
        json={"participantId": "host", "songId": "song", "revision": 2},
    )

    uploading = client.post(
        f"/rooms/{room_id}/readiness",
        json={"participantId": "guest", "readiness": "Downloading", "progress": 37},
    )
    assert uploading.status_code == 200, uploading.text
    assert uploading.json()["transferProgress"] == 37
    assert client.get(f"/rooms/{room_id}").json()["transferProgress"] == 37

    ready = client.post(
        f"/rooms/{room_id}/readiness",
        json={"participantId": "guest", "readiness": "Ready", "progress": 100},
    )
    assert ready.status_code == 200, ready.text
    assert ready.json()["transferProgress"] == 100


def test_selecting_another_participants_song_marks_its_owner_ready_not_the_controller(
    client,
) -> None:
    created = client.post("/rooms", json={"participantId": "host", "displayName": "Host"}).json()
    room_id = created["roomId"]
    client.post(
        f"/rooms/{room_id}/join",
        json={"participantId": "guest", "displayName": "Guest"},
    )
    published = client.post(
        f"/rooms/{room_id}/library",
        json={
            "participantId": "guest",
            "songs": [
                {
                    "songId": "guest-song",
                    "revision": 3,
                    "title": "Guest song",
                    "artist": "Guest",
                    "durationSeconds": 120,
                }
            ],
        },
    )
    assert published.status_code == 200, published.text

    selected = client.post(
        f"/rooms/{room_id}/song",
        json={"participantId": "host", "songId": "guest-song", "revision": 3},
    )

    assert selected.status_code == 200, selected.text
    participants = {person["participantId"]: person for person in selected.json()["participants"]}
    assert participants["guest"]["readinessState"] == "Preparing"
    assert participants["host"]["readinessState"] == "MissingSong"
    assert selected.json()["playbackState"] == "Stopped"


def test_room_sync_check_schedules_one_shared_future_click_sequence(client) -> None:
    created = client.post("/rooms", json={"participantId": "host", "displayName": "Host"}).json()
    room_id = created["roomId"]
    client.post(
        f"/rooms/{room_id}/join",
        json={"participantId": "guest", "displayName": "Guest"},
    )

    first = client.post(f"/rooms/{room_id}/sync-check", json={"participantId": "guest"})
    assert first.status_code == 200, first.text
    payload = first.json()
    assert payload["syncCheckId"] == 1
    assert datetime.fromisoformat(payload["syncCheckStartedAt"]) > datetime.fromisoformat(
        payload["serverNow"]
    )

    second = client.post(f"/rooms/{room_id}/sync-check", json={"participantId": "host"})
    assert second.status_code == 200, second.text
    assert second.json()["syncCheckId"] == 2


def test_host_can_enable_equal_room_controls_for_participants(client) -> None:
    created = client.post("/rooms", json={"participantId": "host", "displayName": "Host"})
    room_id = created.json()["roomId"]
    client.post(
        f"/rooms/{room_id}/join",
        json={"participantId": "guest", "displayName": "Guest"},
    )
    _measure_voice_routes(client, room_id, "host", "guest")

    denied = client.post(
        f"/rooms/{room_id}/song",
        json={"participantId": "guest", "songId": "guest-song", "revision": 1},
    )
    assert denied.status_code == 403

    enabled = client.post(
        f"/rooms/{room_id}/collaborative-control",
        json={"participantId": "host", "enabled": True},
    )
    assert enabled.status_code == 200, enabled.text
    assert enabled.json()["collaborativeControl"] is True

    selected = client.post(
        f"/rooms/{room_id}/song",
        json={"participantId": "guest", "songId": "guest-song", "revision": 1},
    )
    assert selected.status_code == 200, selected.text
    client.post(
        f"/rooms/{room_id}/readiness",
        json={"participantId": "host", "readiness": "Ready"},
    )
    client.post(
        f"/rooms/{room_id}/readiness",
        json={"participantId": "guest", "readiness": "Ready"},
    )
    started = client.post(
        f"/rooms/{room_id}/control",
        json={"participantId": "guest", "command": "Start"},
    )
    assert started.status_code == 200, started.text

    guest_cannot_change_policy = client.post(
        f"/rooms/{room_id}/collaborative-control",
        json={"participantId": "guest", "enabled": False},
    )
    assert guest_cannot_change_policy.status_code == 403


def test_host_transfer_uses_the_oldest_connected_participant(client) -> None:
    room = client.post(
        "/rooms",
        json={"participantId": "host", "displayName": "Host", "disconnectPolicy": "Transfer"},
    ).json()
    room_id = room["roomId"]
    for participant in ("b", "a"):
        client.post(
            f"/rooms/{room_id}/join",
            json={"participantId": participant, "displayName": participant.upper()},
        )

    left = client.post(f"/rooms/{room_id}/leave", json={"participantId": "host"})

    assert left.status_code == 200
    assert left.json()["hostId"] == "b"


def test_close_policy_closes_room_when_host_leaves(client) -> None:
    room = client.post(
        "/rooms",
        json={"participantId": "host", "displayName": "Host", "disconnectPolicy": "Close"},
    ).json()
    room_id = room["roomId"]
    client.post(
        f"/rooms/{room_id}/join",
        json={"participantId": "guest", "displayName": "Guest"},
    )

    left = client.post(f"/rooms/{room_id}/leave", json={"participantId": "host"})

    assert left.status_code == 200
    assert left.json() is None
    missing = client.post(
        f"/rooms/{room_id}/join",
        json={"participantId": "next", "displayName": "Next"},
    )
    assert missing.status_code == 404
    assert missing.json()["code"] == "RoomNotFound"


def test_host_can_explicitly_transfer_authority_to_a_connected_participant(client) -> None:
    room = client.post("/rooms", json={"participantId": "host", "displayName": "Host"}).json()
    room_id = room["roomId"]
    client.post(
        f"/rooms/{room_id}/join",
        json={"participantId": "guest", "displayName": "Guest"},
    )

    transferred = client.post(
        f"/rooms/{room_id}/host",
        json={"participantId": "host", "targetParticipantId": "guest"},
    )

    assert transferred.status_code == 200, transferred.text
    snapshot = transferred.json()
    assert snapshot["hostId"] == "guest"
    roles = {person["participantId"]: person["role"] for person in snapshot["participants"]}
    assert roles == {"host": "Participant", "guest": "Host"}


def test_host_can_remove_a_participant_and_their_published_songs(client) -> None:
    room = client.post("/rooms", json={"participantId": "host", "displayName": "Host"}).json()
    room_id = room["roomId"]
    client.post(
        f"/rooms/{room_id}/join",
        json={"participantId": "guest", "displayName": "Guest"},
    )
    client.post(
        f"/rooms/{room_id}/library",
        json={
            "participantId": "guest",
            "songs": [
                {
                    "songId": "guest-song",
                    "revision": 1,
                    "title": "Guest song",
                    "artist": "Guest",
                    "durationSeconds": 120,
                }
            ],
        },
    )

    kicked = client.post(
        f"/rooms/{room_id}/participants/guest/remove",
        json={"participantId": "host"},
    )

    assert kicked.status_code == 200, kicked.text
    assert [person["participantId"] for person in kicked.json()["participants"]] == ["host"]
    assert kicked.json()["sharedSongs"] == []
    denied = client.post(
        f"/rooms/{room_id}/readiness",
        json={"participantId": "guest", "readiness": "Ready"},
    )
    assert denied.status_code == 403
    assert denied.json()["code"] == "RoomPermissionDenied"


def test_host_can_close_the_room_explicitly(client) -> None:
    room = client.post("/rooms", json={"participantId": "host", "displayName": "Host"}).json()
    room_id = room["roomId"]

    closed = client.post(f"/rooms/{room_id}/close", json={"participantId": "host"})

    assert closed.status_code == 204, closed.text
    assert client.get(f"/rooms/{room_id}").status_code == 404


def test_room_get_returns_authoritative_snapshot(client) -> None:
    created = client.post(
        "/rooms",
        json={"participantId": "host", "displayName": "Host", "disconnectPolicy": "Transfer"},
    ).json()

    snapshot = client.get(f"/rooms/{created['roomId']}")

    assert snapshot.status_code == 200
    fetched = snapshot.json()
    assert fetched.pop("serverNow") is not None
    assert created.pop("serverNow") is not None
    assert fetched == created


def test_room_snapshot_synchronizes_radio_search_and_filters(client) -> None:
    room = client.post(
        "/rooms",
        json={"participantId": "host", "displayName": "Host"},
    ).json()
    room_id = room["roomId"]
    client.post(
        f"/rooms/{room_id}/join",
        json={"participantId": "guest", "displayName": "Guest"},
    )

    updated = client.post(
        f"/rooms/{room_id}/shared-state",
        json={
            "participantId": "host",
            "radioEnabled": True,
            "radioStationId": "groove-salad",
            "libraryQuery": "Надія",
            "libraryStatus": "ready",
            "librarySort": "artist",
            "playbackRate": 0.9,
            "keyShift": -2,
            "musicGain": 0.42,
            "referenceGain": 0.31,
            "melodyGain": 0.27,
        },
    )

    assert updated.status_code == 200
    snapshot = client.get(f"/rooms/{room_id}").json()
    assert snapshot["radioEnabled"] is True
    assert snapshot["radioStationId"] == "groove-salad"
    assert snapshot["libraryQuery"] == "Надія"
    assert snapshot["libraryStatus"] == "ready"
    assert snapshot["librarySort"] == "artist"
    assert snapshot["playbackRate"] == 0.9
    assert snapshot["keyShift"] == -2
    assert snapshot["musicGain"] == 0.42
    assert snapshot["referenceGain"] == 0.31
    assert snapshot["melodyGain"] == 0.27

    denied = client.post(
        f"/rooms/{room_id}/shared-state",
        json={
            "participantId": "guest",
            "radioEnabled": True,
            "radioStationId": "groove-salad",
            "libraryQuery": "Надія",
            "libraryStatus": "ready",
            "librarySort": "artist",
            "playbackRate": 1.1,
            "keyShift": 1,
            "musicGain": 1,
            "referenceGain": 0,
            "melodyGain": 0,
        },
    )
    assert denied.status_code == 403


def test_room_seek_is_authoritative_for_every_participant(client) -> None:
    room = client.post(
        "/rooms",
        json={"participantId": "host", "displayName": "Host"},
    ).json()

    sought = client.post(
        f"/rooms/{room['roomId']}/control",
        json={"participantId": "host", "command": "Seek", "positionSeconds": 42.5},
    )

    assert sought.status_code == 200
    assert sought.json()["playbackPositionSeconds"] == 42.5


def test_room_resume_keeps_the_paused_position(client) -> None:
    room = client.post(
        "/rooms",
        json={"participantId": "host", "displayName": "Host"},
    ).json()
    room_id = room["roomId"]
    _measure_voice_routes(client, room_id, "host")
    client.post(
        f"/rooms/{room_id}/song",
        json={"participantId": "host", "songId": "song", "revision": 1},
    )
    client.post(
        f"/rooms/{room_id}/readiness",
        json={"participantId": "host", "readiness": "Ready"},
    )
    client.post(
        f"/rooms/{room_id}/control",
        json={"participantId": "host", "command": "Start"},
    )
    client.post(
        f"/rooms/{room_id}/control",
        json={"participantId": "host", "command": "Seek", "positionSeconds": 42.5},
    )
    client.post(
        f"/rooms/{room_id}/control",
        json={"participantId": "host", "command": "Pause"},
    )

    resumed = client.post(
        f"/rooms/{room_id}/control",
        json={"participantId": "host", "command": "Start"},
    )

    assert resumed.status_code == 200
    assert resumed.json()["playbackPositionSeconds"] >= 42.5


def test_room_library_contains_ready_songs_published_by_every_member(client) -> None:
    room = client.post(
        "/rooms",
        json={"participantId": "host", "displayName": "Host"},
    ).json()
    room_id = room["roomId"]
    client.post(
        f"/rooms/{room_id}/join",
        json={"participantId": "guest", "displayName": "Guest"},
    )
    for participant, song_id, title in (
        ("host", "song-host", "Host song"),
        ("guest", "song-guest", "Guest song"),
    ):
        response = client.post(
            f"/rooms/{room_id}/library",
            json={
                "participantId": participant,
                "songs": [
                    {
                        "songId": song_id,
                        "revision": 1,
                        "title": title,
                        "artist": participant,
                        "album": None,
                        "genre": None,
                        "durationSeconds": 120,
                    }
                ],
            },
        )
        assert response.status_code == 200

    songs = client.get(f"/rooms/{room_id}").json()["sharedSongs"]
    assert {(song["ownerParticipantId"], song["songId"]) for song in songs} == {
        ("host", "song-host"),
        ("guest", "song-guest"),
    }


def test_host_disconnect_grace_is_resolved_without_sleep() -> None:

    rooms = InMemoryRoomRepository()
    clock = FakeClock()
    locks = RoomLocks()
    room = CreateRoom(rooms, UuidGenerator()).execute(
        "host",
        "Host",
        HostDisconnectPolicy.TRANSFER,
        host_grace_seconds=10.0,
    )
    JoinRoom(rooms, locks=locks).execute(room.room_id, "guest", "Guest")
    DisconnectParticipant(rooms, clock, locks=locks).execute(room.room_id, "host")

    before_deadline = ResolveHostDisconnect(rooms, clock, locks=locks).execute(room.room_id)
    assert before_deadline is not None
    assert before_deadline.host_id == "host"

    clock.advance(10.0)
    after_deadline = ResolveHostDisconnect(rooms, clock, locks=locks).execute(room.room_id)
    assert after_deadline is not None
    assert after_deadline.host_id == "guest"
