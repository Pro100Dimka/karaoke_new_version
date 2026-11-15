from dataclasses import replace

import pytest

from backend.bootstrap.room_wiring import build_room_cases
from backend.domain_errors import ConflictError, ForbiddenError
from backend.infrastructure.ids import UuidGenerator
from backend.infrastructure.sqlite_rooms import SqliteRoomRepository
from backend.room.commands import MediaControlCommand
from backend.room.domain import HostDisconnectPolicy, PlaybackState, ReadinessState, RoomSong
from tests.fakes import FakeClock


@pytest.fixture
def playlist_room(tmp_path):
    repository = SqliteRoomRepository(tmp_path / "rooms.sqlite3")
    cases = build_room_cases(UuidGenerator(), FakeClock(), repository)
    room = cases.create.execute("host", "Host", HostDisconnectPolicy.TRANSFER)
    cases.join.execute(room.room_id, "guest", "Guest")
    songs = tuple(RoomSong("host", name, 1, name, "", None, None, 30) for name in ["one", "two"])
    cases.publish_library.execute(room.room_id, "host", songs)
    return cases, repository, room.room_id


def test_playlist_waits_for_every_saved_recording_and_advances_once(playlist_room):
    cases, repository, code = playlist_room
    first = cases.playlist.execute(code, "host", "Set", (("one", 1), ("two", 1)))
    assert first.song_id == "one" and first.auto_start_pending
    assert first.participants["guest"].readiness_state is ReadinessState.MISSING_SONG
    waiting = cases.playlist.advance(code, "host", first.performance_id)
    assert waiting.song_id == "one" and waiting.playlist.index == 0
    assert repository.get(code).playlist.finished_participants == ("host",)
    second = cases.playlist.advance(code, "guest", first.performance_id)
    assert second.song_id == "two" and second.playlist.index == 1
    assert second.auto_start_pending
    assert cases.playlist.advance(code, "guest", first.performance_id).song_id == "two"
    cases.playlist.advance(code, "guest", second.performance_id)
    ended = cases.playlist.advance(code, "host", second.performance_id)
    assert ended.song_id is None and ended.playlist is None
    assert ended.playback_state is PlaybackState.STOPPED


def test_manual_stop_cancels_playlist_but_natural_stop_preserves_it(playlist_room):
    cases, _, code = playlist_room
    cases.playlist.execute(code, "host", "Set", (("one", 1), ("two", 1)))
    natural = cases.authorize_control.execute(
        code, "host", MediaControlCommand.STOP, continue_playlist=True
    )
    assert natural.playlist is not None
    stopped = cases.authorize_control.execute(code, "host", MediaControlCommand.STOP)
    assert stopped.playlist is None


def test_playlist_cannot_skip_an_unfinished_playing_song(playlist_room):
    cases, repository, code = playlist_room
    selected = cases.playlist.execute(code, "host", "Set", (("one", 1),))
    repository.save(replace(selected, playback_state=PlaybackState.PLAYING))
    with pytest.raises(ConflictError):
        cases.playlist.advance(code, "host", selected.performance_id)
    assert repository.get(code).song_id == "one"


@pytest.mark.parametrize("songs", [(), (("missing", 1),), (("one", 1), ("one", 1))])
def test_invalid_playlist_does_not_change_selection(playlist_room, songs):
    cases, repository, code = playlist_room
    with pytest.raises(ConflictError):
        cases.playlist.execute(code, "host", "Set", songs)
    assert repository.get(code).song_id is None


def test_participant_cannot_replace_playlist_without_control(playlist_room):
    cases, _, code = playlist_room
    with pytest.raises(ForbiddenError):
        cases.playlist.execute(code, "guest", "Set", (("one", 1),))
