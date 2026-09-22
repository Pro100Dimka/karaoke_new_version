from __future__ import annotations

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from fastapi.responses import FileResponse

from backend.api.dependencies import container
from backend.api.song_dto import ImportSongDto, SongDto, SongPageDto, UpdateSongDto, song_dto
from backend.bootstrap.container import ApplicationContainer
from backend.domain_errors import NotFoundError
from backend.songs.domain import Song
from backend.songs.domain import SongStatus
from backend.songs.import_song import ImportSongRequest
from backend.songs.queries import ListSongsQuery
from backend.songs.update_song import UpdateSongRequest
from backend.songs.prepare_clip import LOCAL_CLIP, clip_path

router = APIRouter(prefix="/songs")
ContainerDep = Annotated[ApplicationContainer, Depends(container)]


@router.post("", response_model=SongDto, status_code=201)
def import_song(
    body: ImportSongDto,
    request: Request,
    app: ContainerDep,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> SongDto:
    command = ImportSongRequest(
        source_path=Path(body.source_path),
        title=body.title,
        artist=body.artist,
        language=body.language,
        idempotency_key=idempotency_key,
    )
    return _song_dto(app.songs.import_song.execute(command), request)


@router.get("", response_model=SongPageDto)
def list_songs(
    request: Request,
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
        items=[_song_dto(item, request) for item in page.items],
        next_cursor=page.next_cursor,
    )


@router.get("/{song_id}", response_model=SongDto)
def get_song(song_id: str, request: Request, app: ContainerDep) -> SongDto:
    return _song_dto(app.songs.get_song.execute(song_id), request)


@router.patch("/{song_id}", response_model=SongDto)
def update_song(song_id: str, body: UpdateSongDto, request: Request, app: ContainerDep) -> SongDto:
    command = UpdateSongRequest(
        title=body.title,
        artist=body.artist,
        language=body.language,
        cover_path=Path(body.cover_path) if body.cover_path else None,
    )
    return _song_dto(app.songs.update_song.execute(song_id, command), request)


@router.get("/{song_id}/clip", name="song_clip")
def get_song_clip(song_id: str, app: ContainerDep) -> FileResponse:
    song = app.songs.get_song.execute(song_id)
    path = clip_path(song)
    if song.video_url != LOCAL_CLIP or path is None or not path.is_file():
        raise NotFoundError("ClipMissing", "Downloaded song clip is unavailable")
    return FileResponse(path, media_type="video/mp4", filename="clip.mp4")


@router.delete("/{song_id}", status_code=204)
def delete_song(song_id: str, app: ContainerDep) -> Response:
    app.songs.delete_song.execute(song_id)
    return Response(status_code=204)


def _song_dto(song: Song, request: Request) -> SongDto:
    result = song_dto(song)
    if song.video_url == LOCAL_CLIP:
        result.video_url = str(request.url_for("song_clip", song_id=song.song_id))
    return result
