from __future__ import annotations

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Query, Response

from backend.api.dependencies import container
from backend.api.song_dto import ImportSongDto, SongDto, SongPageDto, UpdateSongDto, song_dto
from backend.bootstrap.container import ApplicationContainer
from backend.songs.domain import SongStatus
from backend.songs.import_song import ImportSongRequest
from backend.songs.queries import ListSongsQuery
from backend.songs.update_song import UpdateSongRequest

router = APIRouter(prefix="/songs")
ContainerDep = Annotated[ApplicationContainer, Depends(container)]


@router.post("", response_model=SongDto, status_code=201)
def import_song(
    body: ImportSongDto,
    app: ContainerDep,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> SongDto:
    request = ImportSongRequest(
        source_path=Path(body.source_path),
        title=body.title,
        artist=body.artist,
        language=body.language,
        idempotency_key=idempotency_key,
    )
    return song_dto(app.songs.import_song.execute(request))


@router.get("", response_model=SongPageDto)
def list_songs(
    app: ContainerDep,
    search: str | None = Query(default=None, max_length=300),
    status: SongStatus | None = None,
    sort: str = Query(default="title", pattern="^(title|artist|createdAt|updatedAt|status)$"),
    descending: bool = False,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: str | None = None,
) -> SongPageDto:
    page = app.songs.list_songs.execute(
        ListSongsQuery(search, status, sort, descending, limit, cursor)
    )
    return SongPageDto(
        items=[song_dto(item) for item in page.items],
        next_cursor=page.next_cursor,
    )


@router.get("/{song_id}", response_model=SongDto)
def get_song(song_id: str, app: ContainerDep) -> SongDto:
    return song_dto(app.songs.get_song.execute(song_id))


@router.patch("/{song_id}", response_model=SongDto)
def update_song(song_id: str, body: UpdateSongDto, app: ContainerDep) -> SongDto:
    request = UpdateSongRequest(
        title=body.title,
        artist=body.artist,
        language=body.language,
        cover_path=Path(body.cover_path) if body.cover_path else None,
    )
    return song_dto(app.songs.update_song.execute(song_id, request))


@router.delete("/{song_id}", status_code=204)
def delete_song(song_id: str, app: ContainerDep) -> Response:
    app.songs.delete_song.execute(song_id)
    return Response(status_code=204)
