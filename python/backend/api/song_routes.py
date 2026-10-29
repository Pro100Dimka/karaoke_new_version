from __future__ import annotations

from pathlib import Path
from types import MappingProxyType
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from fastapi.responses import FileResponse

from backend.api.dependencies import container
from backend.api.song_dto import ImportSongDto, SongDto, SongPageDto, UpdateSongDto, song_dto
from backend.api.song_dto import SongSearchPageDto, SongSummaryDto
from backend.bootstrap.container import ApplicationContainer
from backend.domain_errors import NotFoundError
from backend.songs.domain import CoverState, Language, Song
from backend.songs.domain import SongStatus
from backend.songs.import_song import ImportSongRequest
from backend.songs.queries import ListSongsQuery
from backend.songs.ports import SongFilters
from backend.songs.update_song import UpdateSongRequest
from backend.songs.prepare_clip import LOCAL_CLIP, clip_path
from backend.api.system_routes import JobDto, _job

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


@router.post("/imports", response_model=JobDto, status_code=202)
def start_song_import(
    body: ImportSongDto,
    app: ContainerDep,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> JobDto:
    command = ImportSongRequest(
        source_path=Path(body.source_path),
        title=body.title,
        artist=body.artist,
        language=body.language,
        idempotency_key=idempotency_key,
    )
    return _job(app.songs.start_import.execute(command))


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


@router.get("/summary", response_model=SongSummaryDto)
def song_summary(app: ContainerDep) -> SongSummaryDto:
    summary = app.songs.list_songs.summary()
    return SongSummaryDto(
        total=summary.total, ready=summary.ready, languages=list(summary.languages)
    )


_SEARCH_STATUSES: MappingProxyType[str, tuple[SongStatus, ...]] = MappingProxyType(
    {
        "ready": (SongStatus.READY,),
        "importing": (),
        "processing": (SongStatus.PROCESSING, SongStatus.CANCELLING),
        "queued": (SongStatus.QUEUED,),
        "not-processed": (SongStatus.IMPORTED, SongStatus.CANCELLED),
        "failed": (SongStatus.FAILED, SongStatus.SOURCE_MISSING),
        "invalid": (SongStatus.PROJECT_INVALID,),
    }
)


@router.get("/search", response_model=SongSearchPageDto)
def search_songs(
    request: Request,
    app: ContainerDep,
    search: str | None = Query(default=None, max_length=300),
    status: str = Query(
        default="all",
        pattern="^(all|ready|importing|processing|queued|not-processed|failed|invalid)$",
    ),
    sort: str = Query(
        default="createdAt", pattern="^(title|artist|createdAt|played|duration|bpm)$"
    ),
    descending: bool = True,
    language: Language | None = None,
    duration: str = Query(default="all", pattern="^(all|short|medium|long)$"),
    artwork: str = Query(default="all", pattern="^(all|with|without)$"),
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: str | None = None,
) -> SongSearchPageDto:
    page = app.songs.list_songs.search(
        ListSongsQuery(
            search=search,
            sort=sort,
            descending=descending,
            limit=limit,
            cursor=cursor,
            filters=SongFilters(_SEARCH_STATUSES.get(status), language, duration, artwork),
        )
    )
    return SongSearchPageDto(
        items=[_song_dto(item, request) for item in page.items],
        next_cursor=page.next_cursor,
        total=page.total,
    )


@router.get("/{song_id}", response_model=SongDto)
def get_song(song_id: str, request: Request, app: ContainerDep) -> SongDto:
    return _song_dto(app.songs.get_song.execute(song_id), request)


@router.post("/{song_id}/played", status_code=204)
def mark_song_played(song_id: str, app: ContainerDep) -> Response:
    app.songs.mark_played.execute(song_id)
    return Response(status_code=204)


@router.get("/{song_id}/cover", name="song_cover")
def get_song_cover(song_id: str, app: ContainerDep) -> FileResponse:
    """The user's own cover, otherwise the recognised one from the local cache (fetched once)."""
    song = app.songs.get_song.execute(song_id)
    if (
        song.cover_state == CoverState.CUSTOM
        and song.cover_path is not None
        and song.cover_path.is_file()
    ):
        return FileResponse(song.cover_path)
    cached = app.artwork.path_for(song.artwork_url or "")
    if cached is None:
        raise NotFoundError("CoverMissing", "Song cover is unavailable")
    return FileResponse(cached, headers={"Cache-Control": "max-age=86400"})


@router.get("/{song_id}/waveform")
def get_song_waveform(
    song_id: str, app: ContainerDep, bins: int = Query(120, ge=16, le=480)
) -> list[float]:
    return app.songs.get_waveform.execute(song_id, bins)


@router.delete("/{song_id}/cover", response_model=SongDto)
def remove_song_cover(song_id: str, request: Request, app: ContainerDep) -> SongDto:
    return _song_dto(app.songs.update_song.remove_custom_cover(song_id), request)


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
    if path is None:
        path = (
            app.roots.songs
            / song.song_id
            / "revisions"
            / str(song.active_revision)
            / "media"
            / "clip.mp4"
        )
    if song.video_url != LOCAL_CLIP or path is None or not path.is_file():
        raise NotFoundError("ClipMissing", "Downloaded song clip is unavailable")
    return FileResponse(path, media_type="video/mp4", filename="clip.mp4")


@router.delete("/{song_id}", status_code=204)
def delete_song(song_id: str, app: ContainerDep) -> Response:
    app.songs.delete_song.execute(song_id)
    return Response(status_code=204)


def _song_dto(song: Song, request: Request) -> SongDto:
    result = song_dto(song)
    if song.cover_path is not None or (song.artwork_url or "").startswith(("https://", "http://")):
        result.artwork_url = str(request.url_for("song_cover", song_id=song.song_id))
    if song.video_url == LOCAL_CLIP:
        result.video_url = str(request.url_for("song_clip", song_id=song.song_id))
    return result
