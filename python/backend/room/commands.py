"""Commands that drive a room's song, playback and shared state."""

from __future__ import annotations

from dataclasses import replace
from datetime import timedelta
from enum import StrEnum

from backend.domain_errors import ConflictError, NotFoundError
from backend.room.serialization import RoomLocks, serialized_by_room
from backend.room.domain import (
    ConnectionState,
    Participant,
    PlaybackState,
    ReadinessState,
    Room,
    RoomPlaylist,
    RoomSong,
    room_timing,
)
from backend.room.access import (
    all_ready,
    controller_room,
    host_room,
    load_room,
    member_room,
    paused_room,
    playback_position,
)
from backend.room.ports import RoomRepository
from backend.room.performance import complete_performance, reset_performance
from backend.room.timing_policy import ROOM_TIMING, RoomTiming
from backend.runtime import Clock

# Every coordinated start (song start, sync check) begins this long after the command.
ROOM_START_LEAD = timedelta(seconds=ROOM_TIMING.start_lead_seconds)


class MediaControlCommand(StrEnum):
    START = "Start"
    PAUSE = "Pause"
    SEEK = "Seek"
    STOP = "Stop"


class SelectRoomSong:
    def __init__(self, rooms: RoomRepository, clock: Clock, *, locks: RoomLocks) -> None:
        self._rooms = rooms
        self.room_locks = locks
        self._clock = clock

    @serialized_by_room
    def execute(
        self,
        room_id: str,
        actor_id: str,
        song_id: str,
        revision: int,
        playlist: RoomPlaylist | None = None,
    ) -> Room:
        room = controller_room(self._rooms, room_id, actor_id)
        updated = replace(
            room,
            song_id=song_id,
            selection_id=room.selection_id + 1,
            playlist=playlist,
            revision=revision,
            auto_start_pending=True,
            participants=_prepare_participants(room, actor_id, song_id, revision),
            playback_state=PlaybackState.STOPPED,
            playback_started_at=None,
            playback_position_seconds=0.0,
            singing_timing=None,
        )
        updated = reset_performance(updated).with_timing(room_timing(updated))
        self._rooms.save(updated)
        return updated


def _prepare_participants(
    room: Room, actor_id: str, song_id: str, revision: int
) -> dict[str, Participant]:
    ready = {
        song.owner_participant_id
        for song in room.shared_songs
        if song.song_id == song_id and song.revision == revision
    } or {actor_id}
    # Before the first library publication, only the controller is a known holder.
    return {
        key: replace(
            value,
            readiness_state=ReadinessState.PREPARING
            if key in ready
            else ReadinessState.MISSING_SONG,
            transfer_progress=100 if key in ready else 0,
        )
        for key, value in room.participants.items()
    }


class ClearRoomSong:
    def __init__(self, rooms: RoomRepository, *, locks: RoomLocks) -> None:
        self._rooms = rooms
        self.room_locks = locks

    @serialized_by_room
    def execute(self, room_id: str, actor_id: str) -> Room:
        room = controller_room(self._rooms, room_id, actor_id)
        participants = {
            key: replace(value, readiness_state=ReadinessState.READY, transfer_progress=100)
            for key, value in room.participants.items()
        }
        updated = replace(
            room,
            song_id=None,
            selection_id=room.selection_id + 1,
            playlist=None,
            auto_start_pending=False,
            revision=None,
            participants=participants,
            playback_state=PlaybackState.STOPPED,
            playback_started_at=None,
            playback_position_seconds=0.0,
            singing_timing=None,
        )
        updated = reset_performance(updated).with_timing(room_timing(updated))
        self._rooms.save(updated)
        return updated


class SetRoomPlaylist:
    def __init__(self, rooms: RoomRepository, clock: Clock, *, locks: RoomLocks) -> None:
        self._rooms = rooms
        self.room_locks = locks
        self._select = SelectRoomSong(rooms, clock, locks=locks)
        self._clear = ClearRoomSong(rooms, locks=locks)

    @serialized_by_room
    def execute(
        self,
        room_id: str,
        actor_id: str,
        name: str,
        songs: tuple[tuple[str, int], ...],
    ) -> Room:
        room = controller_room(self._rooms, room_id, actor_id)
        if room.song_id is not None:
            raise ConflictError("RoomSongActive", "Stop the current performance first")
        available = {(song.song_id, song.revision) for song in room.shared_songs}
        if not songs or len(set(songs)) != len(songs) or not set(songs) <= available:
            raise ConflictError("PlaylistSongsUnavailable", "Playlist contains unavailable songs")
        return self._select.execute(room_id, actor_id, *songs[0], RoomPlaylist(name, songs))

    @serialized_by_room
    def advance(self, room_id: str, actor_id: str, performance_id: int) -> Room:
        room = member_room(self._rooms, room_id, actor_id)
        playlist = room.playlist
        if playlist is None or room.performance_id != performance_id:
            return room
        if room.playback_state is not PlaybackState.STOPPED:
            raise ConflictError("RoomSongActive", "Finish the current performance first")
        finished = set(playlist.finished_participants) | {actor_id}
        playlist = replace(playlist, finished_participants=tuple(sorted(finished)))
        room = replace(room, playlist=playlist)
        self._rooms.save(room)
        if any(
            p.connection_state is ConnectionState.CONNECTED and key not in finished
            for key, p in room.participants.items()
        ):
            return room
        index = playlist.index + 1
        if index >= len(playlist.songs):
            return self._clear.execute(room_id, room.host_id)
        song_id, revision = playlist.songs[index]
        if not any(s.song_id == song_id and s.revision == revision for s in room.shared_songs):
            raise ConflictError("PlaylistSongsUnavailable", "Next playlist song is unavailable")
        return self._select.execute(
            room_id,
            room.host_id,
            song_id,
            revision,
            replace(playlist, index=index, finished_participants=()),
        )


class SetParticipantReadiness:
    def __init__(self, rooms: RoomRepository, clock: Clock, *, locks: RoomLocks) -> None:
        self._rooms = rooms
        self.room_locks = locks
        self._clock = clock

    @serialized_by_room
    def execute(
        self,
        room_id: str,
        participant_id: str,
        readiness: ReadinessState,
        progress: int | None = None,
        *,
        selection_id: int,
    ) -> Room:
        room = member_room(self._rooms, room_id, participant_id)
        if selection_id != room.selection_id:
            raise ConflictError("RoomSelectionChanged", "The selected room song has changed")
        participant = room.participants[participant_id]
        participants = dict(room.participants)
        transfer_progress = (
            progress
            if progress is not None
            else (100 if readiness is ReadinessState.READY else participant.transfer_progress)
        )
        participants[participant_id] = replace(
            participant,
            readiness_state=readiness,
            transfer_progress=max(0, min(100, transfer_progress)),
        )
        updated = replace(room, participants=participants)
        updated = start_ready_room(updated, self._clock)
        self._rooms.save(updated)
        return updated


class AuthorizeMediaControl:
    def __init__(self, rooms: RoomRepository, clock: Clock, *, locks: RoomLocks) -> None:
        self._rooms = rooms
        self.room_locks = locks
        self._clock = clock

    @serialized_by_room
    def execute(
        self,
        room_id: str,
        actor_id: str,
        command: MediaControlCommand,
        position_seconds: float | None = None,
        continue_playlist: bool = False,
    ) -> Room:
        room = controller_room(self._rooms, room_id, actor_id)
        if command is MediaControlCommand.START and not all_ready(room):
            raise ConflictError("RoomNotReady", "Required participants are not ready")
        room = _apply_media_control(room, command, position_seconds, self._clock)
        if command is MediaControlCommand.STOP and not continue_playlist:
            room = replace(room, playlist=None)
        self._rooms.save(room)
        return room


class StartRoomSyncCheck:
    def __init__(self, rooms: RoomRepository, clock: Clock, *, locks: RoomLocks) -> None:
        self._rooms = rooms
        self.room_locks = locks
        self._clock = clock

    @serialized_by_room
    def execute(self, room_id: str, actor_id: str) -> Room:
        room = load_room(self._rooms, room_id)
        participant = room.participants.get(actor_id)
        if participant is None or participant.connection_state is not ConnectionState.CONNECTED:
            raise NotFoundError("ParticipantNotFound", "Room participant was not found")
        updated = replace(
            room,
            sync_check_id=room.sync_check_id + 1,
            sync_check_started_at=self._clock.now() + ROOM_START_LEAD,
        )
        self._rooms.save(updated)
        return updated


def start_ready_room(room: Room, clock: Clock) -> Room:
    """Start a selected song once project readiness and voice calibration both permit singing."""
    if (
        room.auto_start_pending
        and room.song_id is not None
        and room.playback_state is PlaybackState.STOPPED
        and all_ready(room)
    ):
        return _apply_media_control(room, MediaControlCommand.START, None, clock)
    return room


def _apply_media_control(
    room: Room, command: MediaControlCommand, position_seconds: float | None, clock: Clock
) -> Room:
    state = room.playback_state
    if command is MediaControlCommand.START:
        if state is not PlaybackState.PAUSED:
            room = reset_performance(room)
        position = room.playback_position_seconds if state is PlaybackState.PAUSED else 0.0
        started_room = replace(
            room,
            playback_state=PlaybackState.PLAYING,
            auto_start_pending=False,
            playback_started_at=clock.now() + ROOM_START_LEAD,
            playback_position_seconds=position,
        )
        if state is PlaybackState.PLAYING:
            return started_room
        return started_room.with_timing(room.singing_timing or room_timing(started_room))
    if command is MediaControlCommand.PAUSE:
        if state is PlaybackState.PAUSED:
            return room
        paused = paused_room(room, clock)
        return replace(
            paused.with_timing(room_timing(paused)),
            singing_timing=_paused_singing_timing(room, clock),
        )
    if command is MediaControlCommand.STOP:
        stopped = replace(
            room,
            playback_state=PlaybackState.STOPPED,
            playback_started_at=None,
            playback_position_seconds=0.0,
            singing_timing=None,
            auto_start_pending=False,
        )
        return complete_performance(stopped.with_timing(room_timing(stopped)))
    position = max(0.0, position_seconds or 0.0)
    started = clock.now() if state is PlaybackState.PLAYING else None
    return replace(room, playback_position_seconds=position, playback_started_at=started)


def _paused_singing_timing(room: Room, clock: Clock) -> RoomTiming | None:
    timing = room.singing_timing
    if (
        timing is None
        and room.playback_started_at is not None
        and clock.now() >= room.playback_started_at
    ):
        timing = RoomTiming(
            room.room_playout_delay_ms, room.room_return_reserve_ms, room.room_timing_source
        )
    return timing


class UpdateSharedRoomState:
    def __init__(self, rooms: RoomRepository, clock: Clock, *, locks: RoomLocks) -> None:
        self._rooms = rooms
        self.room_locks = locks
        self._clock = clock

    @serialized_by_room
    def execute(
        self,
        room_id: str,
        participant_id: str,
        *,
        radio_enabled: bool,
        radio_station_id: str,
        library_query: str,
        library_status: str,
        library_sort: str,
        playback_rate: float,
        key_shift: int,
        music_gain: float,
        reference_gain: float,
        melody_gain: float,
    ) -> Room:
        room = controller_room(self._rooms, room_id, participant_id)
        rate = max(0.5, min(1.5, playback_rate))
        updated = replace(
            _retimed_for_rate(room, rate, self._clock),
            radio_enabled=radio_enabled,
            radio_station_id=radio_station_id,
            library_query=library_query,
            library_status=library_status,
            library_sort=library_sort,
            playback_rate=rate,
            key_shift=max(-12, min(12, key_shift)),
            music_gain=max(0.0, min(1.0, music_gain)),
            reference_gain=max(0.0, min(1.0, reference_gain)),
            melody_gain=max(0.0, min(1.0, melody_gain)),
        )
        self._rooms.save(updated)
        return updated


def _retimed_for_rate(room: Room, rate: float, clock: Clock) -> Room:
    """A tempo change while playing restarts the position clock from where the song is now."""
    if (
        rate == room.playback_rate
        or room.playback_state is not PlaybackState.PLAYING
        or room.playback_started_at is None
    ):
        return room
    now = clock.now()
    return replace(
        room,
        playback_position_seconds=playback_position(room, now),
        playback_started_at=max(now, room.playback_started_at),
    )


class PublishRoomLibrary:
    def __init__(self, rooms: RoomRepository, *, locks: RoomLocks) -> None:
        self._rooms = rooms
        self.room_locks = locks

    @serialized_by_room
    def execute(self, room_id: str, participant_id: str, songs: tuple[RoomSong, ...]) -> Room:
        room = member_room(self._rooms, room_id, participant_id)
        published: dict[str, RoomSong] = {}
        for song in songs:
            published.setdefault(song.song_id, replace(song, owner_participant_id=participant_id))
        # A participant's song keeps its place across republishing (also when its revision
        # changes): the first entry of a song revision names whose room project is authoritative,
        # so a later member announcing the same song can never move ahead of its original sharer.
        shared: list[RoomSong] = []
        for song in room.shared_songs:
            if song.owner_participant_id != participant_id:
                shared.append(song)
            elif song.song_id in published:
                shared.append(published.pop(song.song_id))
        updated = replace(room, shared_songs=(*shared, *published.values()))
        self._rooms.save(updated)
        return updated


class SetCollaborativeControl:
    def __init__(self, rooms: RoomRepository, *, locks: RoomLocks) -> None:
        self._rooms = rooms
        self.room_locks = locks

    @serialized_by_room
    def execute(self, room_id: str, actor_id: str, enabled: bool) -> Room:
        room = host_room(self._rooms, room_id, actor_id)
        updated = replace(room, collaborative_control=enabled)
        self._rooms.save(updated)
        return updated
