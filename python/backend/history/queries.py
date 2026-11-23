from __future__ import annotations

from collections.abc import Collection
from dataclasses import dataclass, replace
from typing import Mapping, Sequence

from backend.history.domain import HistoryEvent
from backend.persistence import UnitOfWorkFactory
from backend.recordings.ports import RecordingRepository


@dataclass(frozen=True, slots=True)
class HistoryPage:
    items: Sequence[HistoryEvent]
    total: int
    limit: int
    offset: int
    # The song each event is about: a recording or analysis event names its take, not the song.
    song_ids: Mapping[str, str | None]
    snapshot: int


class ListHistory:
    def __init__(self, uow: UnitOfWorkFactory) -> None:
        self._uow = uow

    def execute(
        self,
        *,
        limit: int,
        offset: int,
        event_types: Collection[str] | None = None,
        snapshot: int | None = None,
    ) -> HistoryPage:
        with self._uow.create() as transaction:
            # New events must not shift offsets for an open view.
            if snapshot is None:
                snapshot = transaction.history.latest_id()
            items = transaction.history.list(
                limit=limit, offset=offset, event_types=event_types, snapshot=snapshot
            )
            total = transaction.history.count(event_types, snapshot=snapshot)
            enriched, song_ids = _enrich_events(items, transaction.recordings)
        return HistoryPage(enriched, total, limit, offset, song_ids, snapshot)


def _legacy_registration(event: HistoryEvent) -> bool:
    return (
        event.event_type == "RecordingRegistered"
        and event.entity_type == "Recording"
        and "studioMaster" not in (event.details or {})
    )


def _enrich_events(
    items: Sequence[HistoryEvent], recordings: RecordingRepository
) -> tuple[list[HistoryEvent], dict[str, str | None]]:
    recording_ids = tuple(
        {event.entity_id for event in items if event.entity_type == "Recording" and event.entity_id}
    )
    recording_songs = recordings.song_ids(recording_ids)
    legacy_recordings = recordings.get_many(
        tuple(
            {event.entity_id for event in items if event.entity_id and _legacy_registration(event)}
        )
    )
    song_ids: dict[str, str | None] = {}
    enriched: list[HistoryEvent] = []
    for event in items:
        if event.entity_type == "Song":
            song_ids[event.event_id] = event.entity_id
        elif event.entity_type == "Recording" and event.entity_id:
            song_ids[event.event_id] = recording_songs.get(event.entity_id)
            recording = legacy_recordings.get(event.entity_id)
            if (
                recording
                and _legacy_registration(event)
                and (recording.session_metadata or {}).get("studioMaster")
            ):
                event = replace(event, details={**(event.details or {}), "studioMaster": True})
        enriched.append(event)
    return enriched, song_ids
